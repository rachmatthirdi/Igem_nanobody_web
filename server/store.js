// Shared results: what the service has produced, visible to every visitor.
//
// Only data the SERVER made is stored here (analysis output, scored
// candidates, a built FASTA), never state the browser sent, so a visitor cannot
// put text in front of other visitors. Each entry keeps its own clock: it is
// deleted `retentionMs` after it was last written.
//
// Layout:  <dataDir>/shared/results/<id>/{meta.json, data.json, files/<name>}

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ID = /^(target|design|construct)-[A-Za-z0-9_-]{1,40}$/;
const FILE = /^[A-Za-z0-9_.-]{1,120}\.(pdb|fasta)$/;
const KINDS = new Set(["target", "design", "construct"]);

class Store {
  constructor(config) {
    this.config = config;
    this.dir = path.join(config.dataDir, "shared", "results");
    fs.mkdirSync(this.dir, { recursive: true });
    this.index = new Map(); // id -> meta
    this.load();
  }

  load() {
    for (const id of fs.readdirSync(this.dir)) {
      if (!ID.test(id)) continue; // also skips *.tmp-* leftovers
      try {
        this.index.set(id, JSON.parse(fs.readFileSync(path.join(this.dir, id, "meta.json"), "utf8")));
      } catch {
        // Half-written entry from a crash: remove it.
        fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
      }
    }
    this.sweep();
  }

  get retentionMs() {
    return this.config.sharedRetentionDays * 86_400_000;
  }

  // Creates or replaces an entry. `files` maps a file name to its bytes.
  // Written to a temporary folder and renamed, so a reader never sees half an entry.
  put(id, { kind, title, pdbId, summary, data, files = {} }, now = Date.now()) {
    if (!ID.test(id) || !KINDS.has(kind)) throw new Error(`Bad shared result id: ${id}`);
    let bytes = 0;
    for (const [name, content] of Object.entries(files)) {
      if (!FILE.test(name)) throw new Error(`Bad shared file name: ${name}`);
      bytes += Buffer.byteLength(content);
    }
    if (bytes > this.config.sharedMaxEntryBytes) throw new Error("Shared result is too large.");

    const meta = {
      id,
      kind,
      title: String(title || "").slice(0, 300),
      pdbId: pdbIdOrNull(pdbId),
      createdAt: now,
      expiresAt: now + this.retentionMs,
      summary: summary || {},
      files: Object.keys(files),
    };
    const tmp = path.join(this.dir, `${id}.tmp-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(tmp, "files"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify(meta));
    fs.writeFileSync(path.join(tmp, "data.json"), JSON.stringify(data ?? {}));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(tmp, "files", name), content);
    const final = path.join(this.dir, id);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    this.index.set(id, meta);
    this.enforceCap();
    return meta;
  }

  // Newest first. `visible` lets a kind hide entries that are not ready yet.
  list({ kind, pdbId, limit = 50 } = {}, now = Date.now()) {
    return [...this.index.values()]
      .filter((m) => m.expiresAt > now)
      .filter((m) => !kind || m.kind === kind)
      .filter((m) => !pdbId || m.pdbId === pdbId)
      .filter((m) => m.summary?.ready !== false)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  getMeta(id, now = Date.now()) {
    const m = ID.test(id) ? this.index.get(id) : null;
    return m && m.expiresAt > now ? m : null;
  }

  getData(id, now = Date.now()) {
    const meta = this.getMeta(id, now);
    if (!meta) return null;
    try {
      return { meta, data: JSON.parse(fs.readFileSync(path.join(this.dir, id, "data.json"), "utf8")) };
    } catch {
      return null;
    }
  }

  // Absolute path of a stored file, or null. Only names recorded in the
  // entry's meta are served, so no request can name anything else.
  filePath(id, name, now = Date.now()) {
    const meta = this.getMeta(id, now);
    if (!meta || !FILE.test(name) || !meta.files.includes(name)) return null;
    return path.join(this.dir, id, "files", name);
  }

  // Deletes entries past their own expiry. Returns how many were removed.
  sweep(now = Date.now()) {
    let n = 0;
    for (const [id, m] of this.index) {
      if (m.expiresAt > now) continue;
      fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
      this.index.delete(id);
      n += 1;
    }
    // Leftovers of an interrupted write.
    for (const f of fs.readdirSync(this.dir)) {
      if (f.includes(".tmp-")) fs.rmSync(path.join(this.dir, f), { recursive: true, force: true });
    }
    return n;
  }

  // Keeps the folder bounded: past the cap, the oldest entries go first.
  enforceCap() {
    const over = this.index.size - this.config.sharedMaxEntries;
    if (over <= 0) return;
    const oldest = [...this.index.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, over);
    for (const m of oldest) {
      fs.rmSync(path.join(this.dir, m.id), { recursive: true, force: true });
      this.index.delete(m.id);
    }
  }
}

function pdbIdOrNull(v) {
  return typeof v === "string" && /^[A-Z0-9]{4}$/.test(v) ? v : null;
}

module.exports = { Store, ID, FILE };
