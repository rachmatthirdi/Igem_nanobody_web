// All tunables, read once from the environment. Defaults match the plan for
// the public service: 10 backbones x 1 ProteinMPNN sequence per user.

const path = require("path");
const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

const appDir = path.resolve(__dirname, "..");

module.exports = {
  appDir,
  port: int("PORT", 3000),
  host: env.HOST || "0.0.0.0",

  // Session workspaces live under dataDir/sessions, shared model caches under
  // dataDir/shared. When the server itself runs in a container, dataDir must be
  // mounted at the SAME path on the host (see docker-compose.yml): the Docker
  // daemon resolves `-v` paths on the host, not inside this container.
  dataDir: path.resolve(env.NB_DATA || path.join(appDir, "data")),
  image: env.NB_IMAGE || "rachmatthirdi/igem_brawijaya:latest",

  // What one user may ask for.
  limits: {
    maxBackbones: int("NB_MAX_BACKBONES", 10), // per design run
    maxSeqs: int("NB_MAX_SEQS", 1), // ProteinMPNN sequences per backbone
    minLoop: 5,
    maxLoop: 30,
  },
  // Total backbones one session may generate before it is out of quota.
  backboneBudget: int("NB_BACKBONE_BUDGET", 10),

  // Capacity.
  maxQueue: int("NB_MAX_QUEUE", 5), // design jobs waiting for the single GPU
  lightConcurrency: int("NB_LIGHT_CONCURRENCY", 3), // FreeSASA / DiscoTope / codon calls at once
  jobTimeoutMs: int("NB_JOB_TIMEOUT_MIN", 180) * 60_000,
  lightTimeoutMs: int("NB_LIGHT_TIMEOUT_MIN", 15) * 60_000,
  gpuMode: env.NB_GPU_MODE || "auto", // auto | on | off

  // Results every visitor can browse (analysis, designs, constructs). Each one
  // is deleted this long after it was produced.
  sharedRetentionDays: int("NB_SHARED_RETENTION_DAYS", 7),
  sharedMaxEntries: int("NB_SHARED_MAX_ENTRIES", 2000),
  sharedMaxEntryBytes: int("NB_SHARED_MAX_ENTRY_MB", 100) * 1024 * 1024,

  // Hygiene.
  sessionTtlMs: int("NB_SESSION_TTL_HOURS", 72) * 3_600_000,
  sessionDiskBytes: int("NB_SESSION_DISK_MB", 2000) * 1024 * 1024,
  newSessionsPerIpPerHour: int("NB_NEW_SESSIONS_PER_IP_HOUR", 20),
  requestsPerSecond: int("NB_REQUESTS_PER_SECOND", 4),
  maxBodyBytes: 6_000_000,

  // Only trust X-Forwarded-* when a reverse proxy we control sits in front.
  trustProxy: env.NB_TRUST_PROXY === "1",

  // Extra flags added to every tool container, e.g. "--cpus 8 --memory 24g --pids-limit 4096".
  dockerRunArgs: env.NB_DOCKER_RUN_ARGS || "",
};
