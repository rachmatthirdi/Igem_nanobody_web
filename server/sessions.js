// Anonymous, cookie-based sessions. Each one owns a workspace directory that is
// the engine's ROOT, a design-quota counter, an event log for the browser, and
// at most one design job at a time.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SID = /^[a-f0-9]{32}$/;
const LOG_RING = 300;

class Session {
  constructor(id, dir, meta) {
    this.id = id;
    this.dir = dir;
    this.meta = meta; // { created, lastSeen, backbonesUsed }
    this.clients = new Set(); // open SSE responses
    this.ring = []; // recent console/progress events, replayed on reconnect
    this.children = new Set(); // engine child processes in flight
    this.job = null; // the design job that is queued or running
    this.tokens = 20; // request-rate bucket
    this.tokensAt = Date.now();
  }

  save() {
    fs.writeFileSync(path.join(this.dir, "session.json"), JSON.stringify(this.meta), "utf8");
  }

  emit(type, payload) {
    if (type === "console-log" || type === "stage-progress") {
      this.ring.push({ type, payload });
      if (this.ring.length > LOG_RING) this.ring.shift();
    }
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  remaining(budget) {
    return Math.max(0, budget - this.meta.backbonesUsed);
  }
}

class Sessions {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.dataDir, "sessions");
    fs.mkdirSync(this.root, { recursive: true });
    this.live = new Map();
    this.newByIp = new Map();
  }

  // A valid cookie value for a workspace that still exists, else null.
  find(sid) {
    if (typeof sid !== "string" || !SID.test(sid)) return null;
    const cached = this.live.get(sid);
    if (cached) return cached;
    const dir = path.join(this.root, sid);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
      const s = new Session(sid, dir, meta);
      this.live.set(sid, s);
      return s;
    } catch {
      return null;
    }
  }

  // Limits how fast one address can mint sessions, because a fresh session is
  // a fresh quota.
  allowNewSession(ip) {
    const now = Date.now();
    const recent = (this.newByIp.get(ip) || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.config.newSessionsPerIpPerHour) {
      this.newByIp.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.newByIp.set(ip, recent);
    return true;
  }

  create() {
    const id = crypto.randomBytes(16).toString("hex");
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const s = new Session(id, dir, { created: now, lastSeen: now, backbonesUsed: 0 });
    s.save();
    this.live.set(id, s);
    return s;
  }

  // Refills and spends the per-session request bucket. False means "slow down".
  take(session) {
    const now = Date.now();
    const rate = this.config.requestsPerSecond;
    session.tokens = Math.min(30, session.tokens + ((now - session.tokensAt) / 1000) * rate);
    session.tokensAt = now;
    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  }

  touch(session) {
    // Written at most once a minute; it only drives expiry.
    if (Date.now() - session.meta.lastSeen > 60_000) {
      session.meta.lastSeen = Date.now();
      session.save();
    }
  }

  // Deletes workspaces nobody has used within the retention period. A session
  // with a job in flight is never removed.
  sweep(now = Date.now()) {
    let removed = 0;
    for (const sid of fs.readdirSync(this.root)) {
      if (!SID.test(sid)) continue;
      const s = this.find(sid);
      const last = s ? s.meta.lastSeen : fs.statSync(path.join(this.root, sid)).mtimeMs;
      if (s && (s.job || s.children.size)) continue;
      if (now - last < this.config.sessionTtlMs) continue;
      try {
        fs.rmSync(path.join(this.root, sid), { recursive: true, force: true });
        this.live.delete(sid);
        removed += 1;
      } catch (e) {
        console.error(`sweep: could not remove ${sid}: ${e.message}`);
      }
    }
    for (const [ip, times] of this.newByIp) {
      const recent = times.filter((t) => now - t < 3_600_000);
      if (recent.length) this.newByIp.set(ip, recent);
      else this.newByIp.delete(ip);
    }
    return removed;
  }
}

// Bytes under dir, stopping early once `cap` is passed (we only need to know
// whether the limit is exceeded).
function dirSize(dir, cap = Infinity) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        total += fs.statSync(p).size;
        if (total > cap) return total;
      }
    }
  }
  return total;
}

module.exports = { Sessions, Session, dirSize, SID };
