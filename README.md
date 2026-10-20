# CATCHERs Generator (web)

The web version of the CATCHERs Generator, from **CATCHERs** (Computationally
Assisted Target-specific Cell-based Host Engineered Recognitions), an iGEM
project. It takes a visitor from a target protein to a synthesis-ready
nanobody insert, in four steps, in the browser:

Target → Design → Screening → Construct

RCSB PDB, InterPro, FreeSASA, DiscoTope-3.0, RFantibody (RFdiffusion,
ProteinMPNN, RF2), PRODIGY, CodonTransformer and UniProt sit behind one
interface with a live console. Nothing is installed on the visitor's machine.

This repository is split from the desktop (Electron) app; the browser interface
and the Python tools are the same code, and the server reuses the desktop app's
tested orchestration (`server/engine.js`, formerly `electron/main.js`).

**To run it on a server, read [DEPLOY.md](DEPLOY.md).**

## What a visitor gets

| Step | What runs | Where |
| --- | --- | --- |
| **Target** | RCSB download, InterPro, FreeSASA, DiscoTope-3.0, Mol\* viewer | CPU, a few seconds to a few minutes |
| **Design** | RFdiffusion → ProteinMPNN → RF2 → scoring, as one queued job | the server's GPU, one job at a time |
| **Screening** | filters, composite score, metrics import | browser (+ CPU) |
| **Construct** | CodonTransformer, UniProt anchors, plasmid FASTA (downloaded in the browser) | CPU |

**Limits per visitor** (configurable, see DEPLOY.md): up to **10 backbones** in
total, **1 ProteinMPNN sequence** per backbone, loop lengths 5–30, one design
job at a time, and a short shared queue. These are enforced on the server, not
only in the page.

Results are also published to a read-only **shared gallery** that any visitor
can browse; each result is kept for 7 days (see [DEPLOY.md](DEPLOY.md)).

Visitors have no account. A cookie identifies a browser session whose
workspace is deleted after a period of inactivity (72 hours by default).

## How it is built

```text
browser ──HTTPS──▶ Caddy ──▶ server/index.js (Node, no framework)
                              │  validates every request (server/validate.js)
                              │  sessions, quota, queue (server/sessions.js, runner.js)
                              ▼
                    one short-lived Node process per call (server/job-runner.js)
                              │  loads server/engine.js with ROOT = that session's folder
                              ▼
                    docker run <tools image> …   (per stage, --gpus all for designs)
```

- **One process per call** is what makes the reused desktop code safe for many
  users: its global state (workspace folder, cancel flag, running containers)
  belongs to exactly one session.
- **Per-session workspace.** Only that folder is mounted into the tool
  containers, never the whole data directory.
- **Design jobs** are queued with concurrency 1 (one GPU). Progress and the live
  console arrive over server-sent events; the page polls the job for its result.
- **Stop** kills the session's containers (they carry a session label), even if
  the worker process dies first.

## Development

```bash
npm install
PORT=3100 NB_DATA=./data node server/index.js     # needs Docker and the tools image
npm test                                           # no Docker needed
```

`npm test` runs the validation tests (`tests/validate.test.js`), the
amino-acid table and disk-space tests, and the Python tool tests. They cover pure
logic only. They do not start Docker, the GPU stages or the browser interface.

## Project structure

```text
server/        HTTP server, sessions, queue, validation, engine (orchestration)
renderer/      the browser interface (plain JS); js/web-api.js replaces Electron's preload
python/        the tool scripts run inside the tools image
docker/        Dockerfile for the tools image (RFdiffusion, ProteinMPNN, RF2, DiscoTope, …)
Dockerfile     the web server image
docker-compose.yml, Caddyfile, .env.example
tests/         unit tests
scripts/       prewarm.js (download models once)
```

## License

MIT License. See [LICENSE](LICENSE).

The scientific tools in the tools image are separate works under their own
licenses, and **DiscoTope-3.0 and the RF2 weights are licensed for
non-commercial use only**. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
before opening the service to the public.
