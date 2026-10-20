# Deploying the web service

This guide takes a Linux server with a GPU from nothing to a running service.
It says plainly what has and has not been checked (last section).

## What you are deploying

Two containers, started by Docker Compose:

| Service | What it is |
| --- | --- |
| `app` | the Node web server (this repo's `Dockerfile`). It validates requests, keeps sessions and a queue, and starts the **tools image** for every tool run. |
| `proxy` | Caddy: HTTPS in front of `app`. |

The **tools image** (`rachmatthirdi/igem_brawijaya`, 19 GB compressed, about 53 GB
on disk) is not part of Compose. It is pulled once on the host, and `app` starts
one short-lived container from it per tool run, through the host's Docker socket.
Design runs use the GPU (`--gpus all`) through that mechanism; the `app`
container itself needs no GPU.

## 1. What the server needs

- Linux with **Docker Engine** and the **Compose plugin** (`docker compose version`).
- For GPU designs: the NVIDIA driver and the **NVIDIA Container Toolkit**. Check:

  ```bash
  docker run --rm --gpus all ubuntu:22.04 nvidia-smi
  ```

  If that fails, designs will fall back to the CPU, where one backbone takes
  more than an hour. The service will start anyway and say "GPU: none" in its log.
- Disk: about **60 GB** for the tools image, plus the data directory (model
  caches of about 2 GB, then up to `NB_SESSION_DISK_MB` per active user).
- Ports 80 and 443 reachable by your users; outbound HTTPS to RCSB, EBI, UniProt,
  `files.ipd.uw.edu` (RF2 weights), `dl.fbaipublicfiles.com` (DiscoTope's model)
  and Hugging Face (CodonTransformer's model).

## 2. Install

```bash
git clone <this repository> catchers-web && cd catchers-web
cp .env.example .env            # then edit it (see "Settings")
sudo mkdir -p /srv/catchers     # the NB_DATA directory

# the tools image, once (large download):
docker pull rachmatthirdi/igem_brawijaya@sha256:f5cc30e2a20816563ba558fb941b600f971e0f2035958d01305dee5060ac0843

docker compose up -d --build
docker compose logs -f app
```

Wait for these lines in the log:

```text
GPU: <your GPU> (<VRAM> GB)
RF2 weights ready.
Ready.
```

The first start downloads the RF2 weights (about 281 MB). They are fetched at
start-up, never baked into an image, because their licence does not allow
redistribution. Design jobs are refused until the line `Ready.` appears.

Then download the other models once, so the first visitor does not wait for them:

```bash
docker compose exec app node scripts/prewarm.js
```

Open the site (`http://<server>/`, or your domain). The welcome dialog appears,
and the header shows `Backbones left: 10 / 10`.

### HTTPS

Set `SITE_ADDRESS` in `.env` to your domain name (for example
`catchers.example.ac.id`). Caddy then gets a certificate by itself; the domain
must point at the server and ports 80/443 must be reachable. With `:80` the
service speaks plain HTTP, which is only acceptable on a private network or
behind another TLS proxy.

## 3. Settings

All in `.env` (see `.env.example` for the defaults).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NB_DATA` | `/srv/catchers` | Sessions and shared caches. Mounted at the **same path** in the container; see below. |
| `NB_IMAGE` | the pinned digest | Tools image the server runs. |
| `NB_MAX_BACKBONES` | 10 | Most backbones in one design run. |
| `NB_MAX_SEQS` | 1 | ProteinMPNN sequences per backbone. |
| `NB_BACKBONE_BUDGET` | 10 | Backbones one session may generate in total. |
| `NB_MAX_QUEUE` | 5 | Design jobs allowed to wait for the GPU. |
| `NB_LIGHT_CONCURRENCY` | 3 | FreeSASA / DiscoTope / codon calls running at once. |
| `NB_JOB_TIMEOUT_MIN` | 180 | A design job is stopped after this long. |
| `NB_SESSION_TTL_HOURS` | 72 | Idle sessions (and their files) are deleted after this. |
| `NB_SESSION_DISK_MB` | 2000 | A session over this size cannot start a design. |
| `NB_GPU_MODE` | `auto` | `off` forces CPU; `on` forces `--gpus all` if the start-up probe failed. |
| `NB_DOCKER_RUN_ARGS` | empty | Extra flags for every tool container, e.g. `--cpus 8 --memory 24g --pids-limit 4096`. |

"10 designs per user" is implemented as **10 backbones with one ProteinMPNN
sequence each, as a total budget for a browser session**, spendable in one run or
several. A run that fails or is stopped before RFdiffusion has produced
anything is not charged. If you meant something different (for example 10 runs,
or per account), say so; it is a small change in `server/runner.js`.

### Why `NB_DATA` is mounted at the same path

`app` asks the **host's** Docker daemon to start tool containers and to mount
folders into them. The daemon resolves those paths on the host, not inside the
`app` container, so each folder must have the same absolute path on both sides.
That is why `docker-compose.yml` mounts `${NB_DATA}:${NB_DATA}`. Use an absolute
path without spaces or colons.

## 4. Operating it

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f app` |
| Is it healthy | `curl http://localhost/healthz` returns `{"ok":true,"ready":true,...}` |
| Update | `git pull && docker compose up -d --build` (a running design is stopped) |
| What is running on the GPU | `docker ps --filter label=nb.session` |
| Stop everything a runaway session started | `docker kill $(docker ps -q --filter label=nb.session=<id>)` |
| Free the GPU right now | `docker kill $(docker ps -q --filter label=nb.session)` |

The queue lives in memory. A restart ends queued and running jobs; their users
see an error and are not charged for work that produced nothing. Saved projects
and finished results are files in `NB_DATA` and survive restarts. Back up
`NB_DATA/sessions` if you want to keep them; `NB_DATA/shared` can be rebuilt.

## 5. Security: read this before going public

- **The Docker socket is root on the host.** `app` can start any container.
  What protects you is that no part of a request reaches `docker` unchecked:
  every API channel has an explicit shape in `server/validate.js` (tested in
  `tests/validate.test.js`), values placed in the RFantibody shell command are
  numbers or fixed patterns and are checked a second time where they are used,
  paths from the browser are limited to the session's own folder, and the
  image name comes from the environment only. For a public service consider
  putting a Docker socket proxy (for example `tecnativa/docker-socket-proxy`)
  between `app` and the socket, allowing only container create/start/kill/list.
  That has not been set up here.
- **Tool containers have network access** (the tools download models on first
  use) and run as root inside the container with the session folder mounted.
  Add `--memory`, `--cpus` and `--pids-limit` through `NB_DOCKER_RUN_ARGS`.
- **There are no accounts.** A session is a cookie, so clearing cookies gives a
  fresh quota. Creating sessions is limited per IP address (20 per hour by
  default), which slows this down but does not stop a determined person. If the
  limit matters, put campus login in front of the site and map it to a stable
  identifier; that is not built.
- **Privacy.** Sessions store the PDB IDs, sequences and results users produce,
  in `NB_DATA/sessions/<id>/`, for `NB_SESSION_TTL_HOURS` after last use. Say so
  on the site.
- **Licences.** DiscoTope-3.0 is licensed for non-commercial use and the RF2
  weights are under the Rosetta-DL (non-commercial) licence. A free, academic,
  non-commercial service is the intended use; running it as a paid or
  commercial offer is not covered. Check the notices in
  `THIRD_PARTY_NOTICES.md` and ask your institution before launching publicly.

## 6. What has and has not been checked

Checked on a development laptop (Ubuntu, Docker 29, **no GPU**), with the real
tools image:

- The server image builds, and runs **as a container with the host's Docker
  socket and the data directory mounted at the same path** (the setup this
  guide describes), healthy and `Ready`.
- Through that container: PDB download, InterPro, FreeSASA, DiscoTope-3.0,
  scaffold loading and CodonTransformer all ran in real tool containers
  (`scripts/prewarm.js`); shared model caches were reused across sessions.
- In a real browser engine: the Target flow for `1ZVH` (InterPro 10 domains,
  FreeSASA 124 residues, DiscoTope 124 residues), the Design tab (scaffold of
  127 residues with CDRs H1/H2/H3, sliders capped at 10 and 1), then **Run**:
  a real RFdiffusion container started on the CPU, the live console streamed
  its output, **Stop** killed the container, every stage badge showed
  "Stopped", and the backbones charged to the session were refunded.
- A second design from the same session is refused while one is active; the
  quota is charged at start (2 of 10 for a 2-backbone job).
- Request validation, CSRF/cross-origin refusal, path confinement, quota, queue
  order, queue-full, refund rules and session expiry: 43 JavaScript and 21
  Python tests (`npm test`), no Docker needed. The queue and quota tests were
  checked by breaking the code on purpose and confirming they fail.

**Not checked, because it needs your server:**

- **A design run to completion.** Only the start and the stop were exercised;
  RFdiffusion -> ProteinMPNN -> RF2 -> scoring as one job, and the results
  reaching the Screening tab, were not run end to end in this web version (the
  stages are the desktop app's, which did complete on this machine earlier, but
  not through the queue). Do this first on your server.
- A design run on a GPU. No GPU time has been measured, so
  `NB_MAX_QUEUE` and `NB_JOB_TIMEOUT_MIN` are guesses. Run one 10-backbone job
  yourself, note how long it takes, and set them from that: a user's wait is
  roughly (jobs ahead of them) x (that time).
- `docker compose up` with the real Compose plugin (the file was only checked
  with an older `docker-compose`), GPU passthrough from the Compose-started
  server, and HTTPS through Caddy.
- Several people using the service at once.
