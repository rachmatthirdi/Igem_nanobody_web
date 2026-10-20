# Architecture

How the CATCHERs Generator web service is put together, where each part lives,
and what to touch to change something. For installation see
[DEPLOY.md](DEPLOY.md); for the HTTP interface see [API.md](API.md).

## One application, two halves

The service is a **monolith**: one Node process serves the web page *and* the
API, built by one `Dockerfile`. Its two halves live in two folders whose names
come from the desktop (Electron) app this was split from:

| Half | Folder | What it is |
| --- | --- | --- |
| **Frontend** | `renderer/` | The browser interface: plain HTML, CSS and JavaScript, no build step, no framework. |
| **Backend** | `server/` | The HTTP server, sessions, queue, validation and the orchestration that starts the tools. |
| Tool scripts | `python/` | Small Python programs the backend runs inside the tools image (FreeSASA, scoring, codon optimisation, plasmid). |
| Tools image | `docker/` | Dockerfile of the separate image holding RFdiffusion, ProteinMPNN, RF2, DiscoTope, PRODIGY and CodonTransformer. |

The boundary between the halves is the HTTP API ([API.md](API.md)). The
frontend talks to the backend only through `renderer/js/web-api.js`.

```text
 browser ──HTTPS──▶ Caddy (proxy) ──▶ app container: node server/index.js
                                          │  serves renderer/ (frontend)
                                          │  and /api/* (backend)
                                          ▼
                              docker run <tools image>   (one container per tool run)
                                  --gpus all for designs
```

`docker-compose.yml` has two services: `app` (this monolith) and `proxy` (Caddy,
HTTPS only). The tools are not inside `app`; it starts the tools image through
the host's Docker socket for each run.

## Frontend (`renderer/`)

Scripts are loaded in order by `index.html`; they share state through globals
(`window.AppState`, `window.api`, ...).

| File | Role |
| --- | --- |
| `index.html`, `css/` | Page layout and styles; `css/web.css` hides desktop-only controls. |
| `js/web-api.js` | **The only link to the backend.** Defines `window.api` (one method per API channel), the event stream, job polling, the "my results" list and the quota badge. Replaces Electron's preload script. |
| `js/state.js` | `window.AppState`, the state of the four steps. Its field list is also read by the backend (see `server/projects.js`). |
| `js/app.js` | Tab switching, header buttons, projects dialog, progress bars. |
| `js/tab-target.js`, `tab-design.js`, `tab-screening.js`, `tab-construct.js` | The four steps. `tab-design.js` also follows design jobs and resumes them after a reload. |
| `js/shared-results.js` | The public gallery: list, search, detail, "Continue in my workspace". |
| `js/viewer3d.js` | 3D structure viewer (Mol*). |
| `js/gates.js`, `notice.js`, `messages.js`, `console-panel.js`, `a11y.js`, `onboarding.js`, `glossary.js`, `icons.js` | Interface helpers: button gating, error notices, live console, modal focus handling, welcome tour, term tooltips, icons. |
| `js/aa.js` | Three- to one-letter amino-acid table. **Also required by the backend** (`server/engine.js`). |

Rules the frontend follows: the gallery (`shared-results.js`) puts server data
on the page with `textContent`, never `innerHTML`, because that data can contain
text from outside (a structure's title, an InterPro name). The older step code
still uses `innerHTML` for candidate names, which is safe only because
`publish.js` restricts imported candidate ids to letters, digits and `_ . -`.
Every `POST` carries the header `X-NB-Request: 1`. The limits shown by the
sliders come from the server and are enforced there regardless.

## Backend (`server/`)

| File | Role |
| --- | --- |
| `index.js` | HTTP server: static files, `/api/*` routes, cookie sessions, CSRF checks, server-sent events, start-up and shutdown. |
| `config.js` | Every setting, read from `NB_*` environment variables (table in [DEPLOY.md](DEPLOY.md)). |
| `validate.js` | **The security boundary.** One entry per API channel says exactly what the request may contain. Anything else is rejected; the request is rebuilt from known fields only. |
| `sessions.js` | Anonymous sessions (cookie `nb_sid`), per-session workspace, quota counter, request-rate buckets, idle expiry, and the public session label. |
| `runner.js` | Runs engine calls in child processes: a small pool for light calls, a FIFO queue (concurrency 1) for design jobs, quota charge and refund, job records, restart recovery, GPU probe and container clean-up. |
| `job-runner.js` | The child process: loads `engine.js` for one session, runs one handler, exits. |
| `engine.js` | The orchestration inherited from the desktop app (formerly `electron/main.js`): builds and runs `docker run` commands for each tool, fetches PDB/InterPro/UniProt data, reads results. Large, and the least changed part. |
| `store.js` | The shared-results store: entries with their own 7-day clock, search, sweep. |
| `publish.js` | Turns engine output into shared entries (known fields only; files read only from inside the session). |
| `projects.js` | Saves a finished design as a project in the owner's workspace. |
| `download.js`, `disk-space.js` | Helpers used by `engine.js` (file download with progress; free-space check). |

### Why one process per call

`engine.js` keeps state in module scope: the workspace folder, the cancel flag,
the list of running containers. In a service used by many people that state
must belong to one user. Instead of rewriting the engine, every call runs in
its own short-lived process (`job-runner.js`) started with `NB_ROOT` set to
that session's folder. Nothing is shared between sessions, and **Stop** simply
means "tell this session's process to cancel".

### Request lifecycle

1. The browser sends `POST /api/<channel>` with `{ "args": [...] }`.
2. `index.js` finds or creates the session from the cookie, checks the
   request rate, the custom header, the `Origin` and the content type.
3. `validate.js` checks and rebuilds the arguments for that channel.
4. Local channels (GPU status, cancel, ...) are answered directly. Light
   channels go to `runner.light()`; `run-design` goes to `runner.submit()`.
5. A child process runs the engine handler, which starts the tool container
   (`docker run`, with the session folder mounted as `/nbroot`).
6. Log lines and stage progress stream back to the browser over
   `GET /api/events`; the result comes back as the response (light calls) or
   through `GET /api/job/<id>` (design jobs).
7. Finished analyses, designs and constructs are copied to the shared store.

### Design jobs

`run-design` runs RFdiffusion → ProteinMPNN → RF2 → scoring as **one** job, so
another user's job can never slip in between two stages and the quota is
charged in one place.

- Admission (`runner.submit`): the service is ready, no other job for this
  session, quota left, queue not full, workspace not over its size limit.
- The quota is **charged at start** and refunded if the job fails or is stopped
  before RFdiffusion produced anything.
- Each job has a file `sessions/<id>/jobs/<job>.json`, updated on every status
  change, so it can be found after a reload or a restart.
- When it ends, the server saves a project (`projects.js`) and publishes the
  design (`publish.js`), whether or not the page is still open.
- At start-up, jobs left "queued" or "running" by a previous run are marked
  failed and refunded (`runner.recoverJobs`).

## Data on disk (`NB_DATA`)

```text
NB_DATA/
├── sessions/<32 hex>/          one folder per session; the engine's ROOT, mounted as /nbroot
│   ├── session.json            created, last seen, backbones used, last job id
│   ├── cache/pdb, interpro, discotope, anchors, home
│   ├── work/                   tool intermediates and outputs (backbones, RF2 models, ...)
│   ├── output/                 built FASTA files
│   ├── projects/               saved projects (also written by the server after a design)
│   └── jobs/<id>.json          one record per design job
└── shared/
    ├── python/                 tool scripts, copied at start-up, mounted read-only into containers
    ├── hf/, torch/, weights/   model caches shared by every session (RF2 weights, ESM-IF1, CodonTransformer)
    └── results/<id>/           public shared results: meta.json, data.json, files/
```

`sessions/000...0` is a system workspace for start-up checks; it is never
expired. Session folders are deleted `NB_SESSION_TTL_HOURS` after last use;
shared results are deleted `NB_SHARED_RETENTION_DAYS` after they were produced.

## Security model

- **No accounts.** A session is a random 128-bit cookie (`HttpOnly`,
  `SameSite=Strict`, `Secure` behind HTTPS). It is the only credential, so it is
  never shown anywhere; results show a one-way **session label** instead.
- **Everything is validated** in `validate.js` before use. Values that end up
  in the `bash -lc` command line of the RFantibody stages are numbers or fixed
  patterns, and are checked a second time in `engine.js` where they are used.
- **Paths from the browser** are accepted only inside the session's own folder
  (`validate.js`, `publish.js`); symlinks are resolved first.
- **Containers** get only the session folder plus the shared caches. Labels
  (`nb.session=<id>`) let the server stop a session's containers even if its
  process died. Extra limits can be added with `NB_DOCKER_RUN_ARGS`.
- **The Docker socket is root on the host.** Validation is what stands between a
  request and it; see "Security" in [DEPLOY.md](DEPLOY.md) for the recommended
  socket proxy.
- **Public data.** The shared gallery contains only data made by the server,
  rendered with `textContent`, and is read-only.

## Making common changes

| To change... | Edit |
| --- | --- |
| A per-user limit (backbones, sequences, queue) | `.env` (`NB_*`), see [DEPLOY.md](DEPLOY.md); loop-length bounds in `server/config.js` |
| What a request may contain | `server/validate.js` and its test `tests/validate.test.js` |
| Add an API channel | a handler in `server/engine.js`, a shape in `server/validate.js`, a method in `renderer/js/web-api.js`, a row in [API.md](API.md) |
| What gets published to the gallery | `server/publish.js` (+ `tests/store.test.js`) |
| How results are named | `designTitle` / `stamp` in `server/publish.js` |
| Retention of shared results | `NB_SHARED_RETENTION_DAYS` |
| The look of a step | the matching `renderer/js/tab-*.js` and `renderer/index.html` |
| A tool's command line | the handler in `server/engine.js` and the script in `python/` |

## Tests

`npm test` runs, with no Docker or GPU needed:

| File | Covers |
| --- | --- |
| `tests/validate.test.js` | what each channel accepts and rejects (injection, paths, limits) |
| `tests/runner.test.js` | queue order, quota, refunds, session expiry, rate limits |
| `tests/jobs.test.js` | job records, restart recovery, saved projects |
| `tests/store.test.js` | shared store, expiry, search, naming, session label |
| `tests/aa.test.js`, `tests/disk-space.test.js` | amino-acid table, free-space check |
| `tests/test_tools.py` | restriction sites, codon table, CAI (Python) |

They test logic only. They do not start the tool containers, the GPU stages or
the browser interface; what was exercised end to end, and what was not, is
listed in the last section of [DEPLOY.md](DEPLOY.md).
