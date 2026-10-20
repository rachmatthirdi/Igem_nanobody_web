// Runs engine handlers in per-call child processes, and schedules them:
//   - "light" calls (FreeSASA, DiscoTope, codon optimisation, project files...)
//     run a few at a time;
//   - design jobs go through a FIFO queue with concurrency 1, because they
//     share one GPU.

const { fork, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { dirSize } = require("./sessions");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Runner {
  constructor(config, sessions) {
    this.config = config;
    this.sessions = sessions;
    this.shared = path.join(config.dataDir, "shared");
    this.gpu = { cudaAvailable: false, gpuName: null, vramTotalGb: null };
    this.queue = []; // design jobs waiting
    this.running = null; // design job on the GPU
    this.lightActive = 0;
    this.lightWaiting = [];
    this.ready = false; // false until boot tasks (weights, GPU probe) are done
    this.bootError = null;
    this.onDone = null; // called with a finished design job
    this.jobs = new Map(); // id -> job, recent ones only
  }

  // Environment for an engine child. Deliberately not process.env: the child
  // gets what it needs and none of the server's other variables.
  childEnv(session, gpu) {
    const e = process.env;
    return {
      PATH: e.PATH,
      HOME: e.HOME,
      ...(e.DOCKER_HOST ? { DOCKER_HOST: e.DOCKER_HOST } : {}),
      ...(e.DOCKER_CONFIG ? { DOCKER_CONFIG: e.DOCKER_CONFIG } : {}),
      NB_ROOT: session.dir,
      NB_SHARED: this.shared,
      NB_SESSION: session.id,
      NB_GPU: gpu ? "1" : "0",
      NB_IMAGE: this.config.image,
      NB_DOCKER_RUN_ARGS: this.config.dockerRunArgs,
    };
  }

  // Forks an engine child, runs one handler and resolves with its result.
  // `onChild(child)` lets the caller keep a handle so it can cancel.
  call(session, channel, args, { gpu = false, timeoutMs, onChild } = {}) {
    return new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, "job-runner.js"), [], {
        env: this.childEnv(session, gpu),
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      session.children.add(child);
      if (onChild) onChild(child);
      let settled = false;
      let timer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.children.delete(child);
        fn(value);
      };

      timer = setTimeout(() => {
        // Ask politely first so the engine can `docker kill` its containers,
        // then make sure.
        try {
          child.send({ type: "cancel" });
        } catch {}
        setTimeout(() => {
          child.kill("SIGKILL");
          this.killContainers(session.id);
        }, 15_000).unref();
        finish(reject, new HttpError(504, "The step took too long and was stopped."));
      }, timeoutMs || this.config.lightTimeoutMs);

      child.on("message", (msg) => {
        switch (msg.type) {
          case "ready":
            child.send({ type: "call", channel, args });
            break;
          case "console-log":
          case "stage-progress":
            session.emit(msg.type, msg.payload);
            if (session.job && msg.type === "stage-progress") session.job.observe(msg.payload);
            break;
          case "result":
            finish(resolve, msg.value);
            break;
          case "error": {
            const err = new Error(msg.message);
            err.cancelled = !!msg.cancelled;
            finish(reject, err);
            break;
          }
        }
      });
      child.on("error", (e) => finish(reject, e));
      child.on("exit", (code) => {
        if (!settled) finish(reject, new Error(`Worker exited unexpectedly (code ${code}).`));
      });
    });
  }

  // ---- light calls -------------------------------------------------------

  async light(session, channel, args) {
    if (this.lightActive >= this.config.lightConcurrency) {
      if (this.lightWaiting.length >= 20)
        throw new HttpError(503, "The server is busy. Please try again in a minute.");
      await new Promise((resolve) => this.lightWaiting.push(resolve));
    }
    this.lightActive += 1;
    try {
      return await this.call(session, channel, args);
    } finally {
      this.lightActive -= 1;
      const next = this.lightWaiting.shift();
      if (next) next();
    }
  }

  // ---- design jobs -------------------------------------------------------

  position(job) {
    if (this.running === job) return 0;
    const i = this.queue.indexOf(job);
    return i < 0 ? null : i + 1;
  }

  // Admits a design job or throws an HttpError that tells the user why not.
  submit(session, params) {
    const c = this.config;
    if (this.bootError) throw new HttpError(503, "The service is not set up correctly yet. The administrator has been told by the logs.");
    if (!this.ready) throw new HttpError(503, "The server is still starting up. Try again in a minute.");
    if (session.job) throw new HttpError(409, "You already have a design running or waiting. Wait for it or stop it first.");
    const left = session.remaining(c.backboneBudget);
    if (params.numDesigns > left)
      throw new HttpError(
        403,
        left === 0
          ? `You have used all ${c.backboneBudget} backbones available to you.`
          : `You asked for ${params.numDesigns} backbones but only ${left} remain of your ${c.backboneBudget}.`,
      );
    if (this.queue.length >= c.maxQueue)
      throw new HttpError(503, "The design queue is full. Please try again later.");
    if (dirSize(session.dir, c.sessionDiskBytes) > c.sessionDiskBytes)
      throw new HttpError(413, "Your workspace is full. Delete some projects, or start a new session.");

    const job = {
      id: crypto.randomBytes(8).toString("hex"),
      session,
      params,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
      charged: params.numDesigns,
      producedBackbones: false,
      resultId: null,
      child: null,
      cancelRequested: false,
      // Called for each stage-progress event the job produces.
      observe(p) {
        if (p.stage === "rfdiffusion" && p.status === "done") this.producedBackbones = true;
      },
    };
    session.meta.backbonesUsed += job.charged;
    session.save();
    session.job = job;
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.announce(job);
    this.pump();
    return job;
  }

  announce(job) {
    job.session.emit("job", this.view(job));
  }

  view(job) {
    const v = {
      id: job.id,
      status: job.status,
      position: this.position(job),
      queueLength: this.queue.length,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
    };
    if (job.status === "done") {
      v.result = job.result;
      v.resultId = job.resultId || null; // where it can be found in the shared gallery
    }
    if (job.status === "error" || job.status === "cancelled") v.error = job.error;
    return v;
  }

  pump() {
    if (this.running || !this.ready) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    this.execute(job).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  async execute(job) {
    const s = job.session;
    job.status = "running";
    job.startedAt = Date.now();
    this.announce(job);
    try {
      job.result = await this.call(s, "run-design", [job.params], {
        gpu: this.gpu.cudaAvailable,
        timeoutMs: this.config.jobTimeoutMs,
        onChild: (child) => {
          job.child = child;
          // A stop pressed in the instant before the child existed.
          if (job.cancelRequested) {
            try {
              child.send({ type: "cancel" });
            } catch {}
          }
        },
      });
      job.status = "done";
      try {
        if (this.onDone) job.resultId = this.onDone(job)?.id || null;
      } catch (e) {
        console.error(`Could not publish design ${job.id}: ${e.message}`);
      }
    } catch (e) {
      job.status = e.cancelled || job.cancelRequested ? "cancelled" : "error";
      job.error = e.cancelled || job.cancelRequested ? "Cancelled by user." : e.message;
    } finally {
      job.endedAt = Date.now();
      // Nothing came out of RFdiffusion, so nothing was spent.
      if (job.status !== "done" && !job.producedBackbones) {
        s.meta.backbonesUsed = Math.max(0, s.meta.backbonesUsed - job.charged);
        s.save();
      }
      s.job = null;
      job.child = null;
      this.announce(job);
      setTimeout(() => this.jobs.delete(job.id), 3_600_000).unref();
    }
  }

  // Stop whatever the session has running or waiting. Returns whether
  // something was actually interrupted.
  cancel(session) {
    let wasRunning = false;
    const job = session.job;
    if (job) {
      job.cancelRequested = true;
      const i = this.queue.indexOf(job);
      if (i >= 0) {
        this.queue.splice(i, 1);
        job.status = "cancelled";
        job.error = "Cancelled by user.";
        job.endedAt = Date.now();
        session.meta.backbonesUsed = Math.max(0, session.meta.backbonesUsed - job.charged);
        session.save();
        session.job = null;
        this.announce(job);
      } else {
        wasRunning = true;
      }
    }
    for (const child of session.children) {
      wasRunning = true;
      try {
        child.send({ type: "cancel" });
      } catch {}
    }
    if (wasRunning) {
      // Backstop: if the child does not stop its containers, label-kill them.
      setTimeout(() => {
        if (session.children.size) this.killContainers(session.id);
      }, 20_000).unref();
    }
    return wasRunning;
  }

  // Containers are detached from the `docker run` client that started them, so
  // killing a process does not stop them. They carry a session label for this.
  killContainers(sid) {
    const filter = sid ? `label=nb.session=${sid}` : "label=nb.session";
    const ls = spawnSync("docker", ["ps", "-q", "--filter", filter], { encoding: "utf8", timeout: 10_000 });
    const ids = (ls.stdout || "").split(/\s+/).filter(Boolean);
    if (ids.length) spawnSync("docker", ["kill", ...ids], { timeout: 15_000 });
    return ids.length;
  }

  // ---- start-up ----------------------------------------------------------

  async boot(log = console.log) {
    const c = this.config;
    for (const d of ["python", "hf", "torch", "weights", "system"])
      fs.mkdirSync(path.join(this.shared, d), { recursive: true });

    // The tool scripts are bind-mounted into every container from here (the
    // Docker daemon needs a path on the host, which the app directory inside
    // this server's own container is not).
    const src = path.join(c.appDir, "python");
    const dst = path.join(this.shared, "python");
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });

    // Without the tools image every request would fail with a Docker error,
    // so say so once, clearly, and refuse design jobs.
    const have = spawnSync("docker", ["image", "inspect", c.image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 30_000 });
    if (have.status !== 0) {
      this.bootError = `The tools image is not on this host. Run: docker pull ${c.image}`;
      log(this.bootError);
      return;
    }

    const orphans = this.killContainers(null);
    if (orphans) log(`Stopped ${orphans} container(s) left over from a previous run.`);

    const system = this.sessions.find("0".repeat(32)) || this.systemSession();
    // GPU probe.
    if (c.gpuMode === "off") {
      this.gpu = { cudaAvailable: false, gpuName: null, vramTotalGb: null };
    } else {
      try {
        this.gpu = await this.call(system, "check-gpu", [], { timeoutMs: 120_000 });
      } catch (e) {
        log(`GPU probe failed: ${e.message}`);
      }
      if (c.gpuMode === "on" && !this.gpu.cudaAvailable)
        this.gpu = { ...this.gpu, cudaAvailable: true, gpuName: this.gpu.gpuName || "forced on" };
    }
    log(`GPU: ${this.gpu.cudaAvailable ? `${this.gpu.gpuName} (${this.gpu.vramTotalGb} GB)` : "none - designs will run on the CPU and take hours"}`);

    // RF2 weights (Rosetta-DL licence: fetched here, never baked into an image).
    try {
      await this.call(system, "prefetch-rf2", [], { timeoutMs: 30 * 60_000 });
      log("RF2 weights ready.");
    } catch (e) {
      log(`RF2 weights NOT ready: ${e.message}. Design jobs will try to download them.`);
    }
    this.ready = true;
    this.pump();
  }

  // A workspace for work that belongs to no user (start-up checks).
  systemSession() {
    const dir = path.join(this.sessions.root, "0".repeat(32));
    fs.mkdirSync(dir, { recursive: true });
    const { Session } = require("./sessions");
    const s = new Session("0".repeat(32), dir, { created: Date.now(), lastSeen: Date.now() + 10 * 365 * 86400_000, backbonesUsed: 0 });
    s.save();
    this.sessions.live.set(s.id, s);
    return s;
  }
}

module.exports = { Runner, HttpError };
