// HTTP front of the service: static pages, a JSON API that mirrors the desktop
// app's IPC channels, and a server-sent-events stream for the live console.
// No dependencies beyond Node itself.

const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { Sessions, dirSize, sessionLabel } = require("./sessions");
const { Runner, HttpError } = require("./runner");
const { validate, ValidationError, LOCAL_CHANNELS, QUEUED_CHANNELS } = require("./validate");
const { Store, ID } = require("./store");
const { publishTarget, publishDesign, publishConstruct } = require("./publish");
const { saveProject } = require("./projects");

const sessions = new Sessions(config);
const runner = new Runner(config, sessions);
const store = new Store(config);
// A finished design goes to the shared gallery and is saved as a project in the
// owner's workspace; either may fail without hurting the other.
runner.onDone = (job) => {
  const out = {};
  try {
    out.resultId = publishDesign(store, job.session.dir, job, sessionLabel(job.session.id)).id;
  } catch (e) {
    console.error(`Could not publish design ${job.id}: ${e.message}`);
  }
  try {
    out.projectId = saveProject(config.appDir, job.session, job);
  } catch (e) {
    console.error(`Could not save project for design ${job.id}: ${e.message}`);
  }
  return out;
};
const RENDERER = path.join(config.appDir, "renderer");
let scaffoldCache = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// Only these parts of node_modules are ever served.
const NODE_MODULES_ALLOWED = [/^lucide\/dist\/umd\//, /^pdbe-molstar\/build\//];

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

// The browser never sees where the server keeps its files: a session's
// directory is shown as /nbroot (the same name the tool containers use) and
// translated back on the way in.
const SESSION_DIR_RE = new RegExp(
  `${path.join(config.dataDir, "sessions").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-f0-9]{32}`,
  "g",
);
const maskPaths = (text) => text.replace(SESSION_DIR_RE, "/nbroot");

function json(res, status, value, headers = {}) {
  send(res, status, maskPaths(JSON.stringify(value)), { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || "unknown";
}

function isHttps(req) {
  return !!req.socket.encrypted || (config.trustProxy && req.headers["x-forwarded-proto"] === "https");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(new HttpError(413, "Request too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Finds the caller's session from its cookie, or starts one.
function sessionFor(req, res) {
  const existing = sessions.find(parseCookies(req).nb_sid);
  if (existing) {
    sessions.touch(existing);
    return existing;
  }
  if (!sessions.allowNewSession(clientIp(req)))
    throw new HttpError(429, "Too many new sessions from your address. Try again later.");
  const s = sessions.create();
  const cookie = [
    `nb_sid=${s.id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
    isHttps(req) ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
  res.setHeader("Set-Cookie", cookie);
  return s;
}

// Browsers send the custom header only from same-origin script (it forces a
// CORS preflight cross-origin), and SameSite=Strict already keeps the cookie
// off cross-site requests. The Origin check is a third, independent layer.
function assertSameOriginPost(req) {
  if (req.headers["x-nb-request"] !== "1") throw new HttpError(403, "Missing request header.");
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, "Bad origin.");
    }
    const expected = (config.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host;
    if (host !== expected) throw new HttpError(403, "Cross-origin request refused.");
  }
  if (!/^application\/json\b/i.test(req.headers["content-type"] || ""))
    throw new HttpError(415, "Content-Type must be application/json.");
}

// ---------------------------------------------------------------------------
// Local channels: answered here, without starting an engine process
// ---------------------------------------------------------------------------
function localChannel(channel, session) {
  switch (channel) {
    case "get-platform-info":
      return { platform: "linux", isWSL: false, label: "Web service" };
    case "check-gpu":
      return runner.gpu;
    case "check-docker":
      return { available: true };
    case "get-docker-storage-info":
      return { dockerRootDir: "Managed by the server", dockerImage: config.image };
    case "begin-pipeline":
      return true;
    case "cancel-pipeline":
      return { cancelled: true, wasRunning: runner.cancel(session) };
    default:
      // get/save-settings are handled in the browser; pull/build/test-gpu make
      // no sense on a service whose image is fixed by the operator.
      throw new HttpError(404, "This action is not available in the web version.");
  }
}

function limitsFor(session) {
  return {
    sessionLabel: sessionLabel(session.id),
    ...runner.jobsFor(session),
    maxBackbones: config.limits.maxBackbones,
    maxSeqs: config.limits.maxSeqs,
    budget: config.backboneBudget,
    used: session.meta.backbonesUsed,
    remaining: session.remaining(config.backboneBudget),
    queueMax: config.maxQueue,
    queueLength: runner.queue.length,
    gpu: runner.gpu.cudaAvailable,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  if (url.pathname === "/api/shared" || url.pathname.startsWith("/api/shared/")) return handleShared(req, res, url);
  const session = sessionFor(req, res);
  if (!sessions.take(session)) throw new HttpError(429, "Too many requests. Slow down a little.");

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    for (const ev of session.ring) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    if (session.job) res.write(`event: job\ndata: ${JSON.stringify(runner.view(session.job))}\n\n`);
    session.clients.add(res);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(beat);
      session.clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/limits") return json(res, 200, limitsFor(session));

  let m = /^\/api\/job\/([a-f0-9]{16})$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const view = runner.getJob(session, m[1]);
    if (!view) throw new HttpError(404, "No such job.");
    return json(res, 200, view);
  }

  m = /^\/api\/download\/([\w.-]{1,100})$/.exec(url.pathname);
  if (req.method === "GET" && m) {
    const file = path.join(session.dir, "output", m[1]);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, "No such file.");
    return send(res, 200, fs.readFileSync(file), {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${m[1]}"`,
      "Cache-Control": "no-store",
    });
  }

  m = /^\/api\/([a-z0-9-]{1,40})$/.exec(url.pathname);
  if (req.method === "POST" && m) {
    assertSameOriginPost(req);
    const channel = m[1];
    let body;
    try {
      body = JSON.parse((await readBody(req)).split("/nbroot").join(session.dir) || "{}");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "Body is not valid JSON.");
    }

    if (LOCAL_CHANNELS.has(channel)) return json(res, 200, { result: localChannel(channel, session) });

    const args = validate(channel, body.args ?? [], { root: session.dir, limits: config.limits });

    if (channel === "import-shared") return json(res, 200, { result: importShared(session, args[0].id) });

    if (QUEUED_CHANNELS.has(channel)) {
      const job = runner.submit(session, args[0]);
      return json(res, 202, { result: runner.view(job) });
    }
    // The scaffold never changes, and reading it costs a container start, so
    // it is read once for everyone.
    if (channel === "get-scaffold-sequence") {
      scaffoldCache ??= runner.light(session, channel, args).catch((e) => {
        scaffoldCache = null;
        throw e;
      });
      return json(res, 200, { result: await scaffoldCache });
    }
    const value = await runner.light(session, channel, args);
    const meta = publishLightResult(session, channel, args, value);
    // Tell the user where their construct can be found again.
    if (meta && channel === "build-plasmid" && value && typeof value === "object") value.sharedId = meta.id;
    return json(res, 200, { result: value });
  }

  throw new HttpError(404, "Not found.");
}

// Copies a finished analysis or construct into the shared store. A failure
// here is logged and never reaches the user: their own result is fine.
function publishLightResult(session, channel, args, value) {
  try {
    let meta = null;
    const stem = (p) => /([A-Z0-9]{4})_chainA\.pdb$/.exec(String(p))?.[1];
    if (channel === "fetch-pdb") {
      // Browsing a structure is not a result; only name an entry that exists.
      if (!store.getMeta(`target-${value.pdbId}`)) publishTarget(store, value.pdbId, { title: value.title });
    } else if (channel === "run-freesasa") {
      const id = stem(args[0].chainAPath);
      if (id) publishTarget(store, id, { sasa: value.residues });
    } else if (channel === "run-discotope") {
      publishTarget(store, args[0].pdbId, { discotope: value.residues });
    } else if (channel === "run-interpro") {
      publishTarget(store, args[0].pdbId, { domains: value.domains });
    } else if (channel === "build-plasmid") {
      meta = publishConstruct(store, session.dir, args[0], value, require("crypto").randomBytes(4).toString("hex"), sessionLabel(session.id));
    }
    return meta;
  } catch (e) {
    console.error(`Could not publish ${channel}: ${e.message}`);
    return null;
  }
}

// Copies a shared design's structures into the caller's own workspace, so the
// Screening and Construct steps can work on someone else's result. The files
// come from the store (written by the server), never from the caller.
function importShared(session, id) {
  const entry = store.getData(id);
  if (!entry || entry.meta.kind !== "design") throw new HttpError(404, "No such design (it may have expired).");
  if (dirSize(session.dir, config.sessionDiskBytes) > config.sessionDiskBytes)
    throw new HttpError(413, "Your workspace is full. Delete some projects, or start a new session.");
  const dir = path.join(session.dir, "work", `shared_${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const candidates = [];
  for (const c of entry.data.candidates) {
    if (!c.file) continue;
    const src = store.filePath(id, c.file);
    if (!src) continue;
    const dst = path.join(dir, c.file);
    fs.copyFileSync(src, dst);
    const { file, ...metrics } = c;
    candidates.push({ ...metrics, pdbPath: dst });
  }
  return { id, pdbId: entry.meta.pdbId, params: entry.data.params, candidates };
}

// Read-only and public: no session is created or needed. Rate limited per
// address instead.
const ipTokens = new Map();
function ipAllowed(ip) {
  const now = Date.now();
  const b = ipTokens.get(ip) || { t: 20, at: now };
  b.t = Math.min(20, b.t + ((now - b.at) / 1000) * 2);
  b.at = now;
  ipTokens.set(ip, b);
  if (b.t < 1) return false;
  b.t -= 1;
  return true;
}

function handleShared(req, res, url) {
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed.");
  if (!ipAllowed(clientIp(req))) throw new HttpError(429, "Too many requests. Slow down a little.");

  if (url.pathname === "/api/shared") {
    const kind = url.searchParams.get("kind") || undefined;
    if (kind && !["target", "design", "construct"].includes(kind)) throw new HttpError(400, "Unknown kind.");
    const pdb = (url.searchParams.get("pdb") || "").toUpperCase() || undefined;
    if (pdb && !/^[A-Z0-9]{4}$/.test(pdb)) throw new HttpError(400, "Invalid PDB ID.");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
    const q = (url.searchParams.get("q") || "").slice(0, 100);
    let ids;
    if (url.searchParams.get("ids") !== null) {
      ids = url.searchParams.get("ids").split(",").filter((x) => ID.test(x)).slice(0, 50);
    }
    return json(res, 200, { retentionDays: config.sharedRetentionDays, entries: store.list({ kind, pdbId: pdb, q, ids, limit }) });
  }

  const m = /^\/api\/shared\/([A-Za-z0-9_-]{1,60})(?:\/file\/([A-Za-z0-9_.-]{1,130}))?$/.exec(url.pathname);
  if (!m) throw new HttpError(404, "Not found.");
  if (!m[2]) {
    const entry = store.getData(m[1]);
    if (!entry) throw new HttpError(404, "No such result (it may have expired).");
    return json(res, 200, entry);
  }
  const file = store.filePath(m[1], m[2]);
  if (!file) throw new HttpError(404, "No such file.");
  const download = url.searchParams.get("download") === "1";
  return send(res, 200, fs.readFileSync(file), {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...(download ? { "Content-Disposition": `attachment; filename="${m[2]}"` } : {}),
  });
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "Bad path.");
  }
  if (rel === "/") rel = "/index.html";
  rel = rel.replace(/^\/+/, "");

  let base = RENDERER;
  if (rel.startsWith("node_modules/")) {
    rel = rel.slice("node_modules/".length);
    if (!NODE_MODULES_ALLOWED.some((re) => re.test(rel))) throw new HttpError(404, "Not found.");
    base = path.join(config.appDir, "node_modules");
  }
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) throw new HttpError(404, "Not found.");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(404, "Not found.");
  }
  if (!stat.isFile()) throw new HttpError(404, "Not found.");
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/healthz")
      return json(res, 200, { ok: true, ready: runner.ready, queued: runner.queue.length, running: !!runner.running });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    return serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError || e instanceof ValidationError) return json(res, e.status, { error: e.message });
    // An engine error (tool failure, bad upstream response...) is a plain
    // Error whose message the user needs to read, as in the desktop app. Real
    // bugs (TypeError and friends) are logged and not shown.
    if (e && e.constructor === Error) return json(res, 500, { error: e.message, cancelled: !!e.cancelled });
    console.error(e);
    return json(res, 500, { error: "Internal error." });
  }
});

async function start() {
  server.listen(config.port, config.host, () =>
    console.log(`Listening on http://${config.host}:${config.port} (data: ${config.dataDir})`),
  );
  setInterval(() => {
    const n = sessions.sweep();
    if (n) console.log(`Removed ${n} expired session(s).`);
    const r = store.sweep();
    if (r) console.log(`Removed ${r} expired shared result(s).`);
  }, 10 * 60_000).unref();
  await runner.boot((m) => console.log(m));
  console.log("Ready.");
}

function shutdown() {
  console.log("Shutting down; stopping tool containers.");
  runner.killContainers(null);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (require.main === module) {
  start().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

module.exports = { server, sessions, runner, start };
