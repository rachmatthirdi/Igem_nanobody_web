# HTTP API

What the frontend (`renderer/js/web-api.js`) calls on the backend (`server/`).
The authoritative definition of each channel's input is `server/validate.js`;
this page summarises it. See [ARCHITECTURE.md](ARCHITECTURE.md) for context.

## Conventions

- **Session.** The first `/api/*` call (other than the public gallery) sets the
  cookie `nb_sid`. It identifies the session; send it back on every call.
- **Calls** are `POST /api/<channel>` with `Content-Type: application/json`,
  the header `X-NB-Request: 1`, and the body `{ "args": [ ... ] }`.
  A request with an `Origin` different from the host is refused.
- **Answers** are JSON: `{ "result": ... }` on success, `{ "error": "..." }`
  otherwise. Paths in answers are shown as `/nbroot/...`; send them back
  unchanged.
- **Status codes.** `400` invalid input · `403` missing header, cross-origin, or
  quota used up · `404` unknown channel or not found · `405` wrong method · `409`
  a design is already queued or running · `413` too large or workspace full ·
  `415` not JSON · `429` too many requests · `500` a tool failed (message is
  the tool's) · `503` busy, not ready, or queue full · `504` a step timed out.
- **Limits** (defaults; see DEPLOY.md): 10 backbones per run and in total per
  session, 1 ProteinMPNN sequence per backbone, loop lengths 5–30, hotspots
  1–20, temperature 0.05–1, 1–10 recycles.

## Session and status

| Method and path | Answer |
| --- | --- |
| `GET /healthz` | `{ ok, ready, queued, running }` (no session) |
| `GET /api/limits` | `{ sessionLabel, activeJob, lastJob, maxBackbones, maxSeqs, budget, used, remaining, queueMax, queueLength, gpu }` |
| `GET /api/events` | Server-sent events for this session: `console-log` `{level, text, source, ts}`, `stage-progress` `{stage, percent, status, message, ts}`, `job` (a job view). Recent log lines are replayed on connect. |
| `GET /api/download/<file>` | A file from this session's `output/` as a download (a built FASTA). |

## Channels (`POST /api/<channel>`)

### Target

| Channel | `args` | Result |
| --- | --- | --- |
| `fetch-pdb` | `[pdbId]` | `{ pdbId, pdbPath, chainAPath, sizeKB, title }` |
| `get-structure-title` | `[pdbId]` | title string |
| `read-pdb-file` | `[path]` (a `.pdb` inside the session) | PDB text |
| `run-interpro` | `[{ pdbId, forceRefresh }]` | `{ domains, fromCache }` |
| `run-freesasa` | `[{ chainAPath }]` | `{ residues: [{ resNum, residue, sasa, rsa, ... }] }` |
| `run-discotope` | `[{ chainAPath, pdbId, forceRefresh }]` | `{ residues: [{ resNum, residue, discotopeScore, calibratedScore, rsa, predictedEpitope, ... }], fromCache }` |

`chainAPath` must be `<session>/cache/pdb/<ID>_chainA.pdb`, the file `fetch-pdb`
wrote. A PDB ID is exactly four letters or digits.

### Design

| Channel | `args` | Result |
| --- | --- | --- |
| `get-scaffold-sequence` | `[{ scaffoldName }]` (always the 3DWT scaffold) | `{ scaffoldName, filePath, sequence, residueNumbers, cdr }` |
| `run-design` | `[{ targetPdbPath, pdbId, designLoops, hotspotResidues, numDesigns, designsPerBackbone, temperature, numRecycles, cdr }]` | **202** with a job view (below) |
| `cancel-pipeline` | `[]` | `{ cancelled, wasRunning }`: stops this session's queued or running job and tool containers |
| `begin-pipeline` | `[]` | `true` (kept for compatibility; has no effect) |

`designLoops` looks like `H1:7,H2:6,H3:9`. `run-design` runs all four stages as
one queued job.

#### Job view

```json
{ "id": "16 hex", "status": "queued|running|done|error|cancelled",
  "position": 0, "queueLength": 0, "createdAt": 0, "startedAt": 0,
  "params": { }, "stages": { "rfdiffusion": "running" }, "projectId": null,
  "result": { "backbones": [], "backboneDir": "", "targetTPath": "", "seqDir": "",
              "rf2OutDir": "", "candidates": [] },
  "resultId": "design-...", "error": "..." }
```

`result` and `resultId` appear when `status` is `done`; `error` when it is `error`
or `cancelled`. Poll `GET /api/job/<id>` (only the owning session can read it).
A candidate is `{ id, pdbPath, plddt, pae, interactionPae, cdrRmsd, h3Rmsd, dg }`.

### Screening and Construct

| Channel | `args` | Result |
| --- | --- | --- |
| `import-metrics-dialog` | `[{ candidates, fileName, text }]` (`.json`, `.csv`, `.sc`, up to 2 MB) | `{ candidates, imported, fileName }` |
| `codon-optimize` | `[{ aminoAcidSeq, organism }]` | `{ sequence_dna, cai, gc_content, method }` |
| `calculate-cai` | `[{ dnaSeq }]` | `{ cai, numCodons, unknownCodons, gc_content, method }` |
| `fetch-anchor` | `[{ type, forceRefresh }]` (`lpp-ompa` or `intimin`) | `{ type, label, hasNativeSignal, sequence, header, source, segments }` |
| `build-anchor-construct` | `[{ anchorSeq, nanobodyDna, organism }]` | `{ construct_dna, components, anchor_method, linker_aa }` |
| `build-plasmid` | `[{ constructDna, vector, includePelb, anchorHasNativeSignal, candidateId, cai }]` | `{ fastaPath, preview, lengthBp, gcContent, cai, vector, includePelb, restrictionFixes, restrictionUnresolved, notes, sharedId }` |
| `open-output-folder` | `[]` | `[{ name, bytes, mtimeMs }]`, newest first (the browser downloads the first) |

Organisms: `Escherichia coli general`, `Homo sapiens`, `Pichia pastoris`.
Vectors: `pET-28a(+)`, `pET-22b(+)`. `sharedId` is where the construct appears in
the gallery.

### Projects

| Channel | `args` | Result |
| --- | --- | --- |
| `save-project` | `[state]` | `{ id, filePath }` |
| `load-project` | `[id]` | the state |
| `list-projects` | `[]` | `[{ id, name, savedAt }]`, newest first |
| `delete-project` | `[id]` | `true` |

A project id is letters, digits, `_`, `.`, `-`, starting with a letter or digit.
The server also saves one when a design finishes.

### Status and compatibility

| Channel | Answer |
| --- | --- |
| `check-gpu` | `{ cudaAvailable, gpuName, vramTotalGb }`, measured once at start-up |
| `get-platform-info` | `{ platform, isWSL, label }` (a fixed "Web service") |
| `check-docker`, `get-docker-storage-info` | fixed answers so the desktop screens keep working |

Channels from the desktop app that make no sense on a service (`pull-docker-image`,
`run-docker-build`, `test-gpu-docker`, `get-settings`, ...) answer `404`.
Anything not listed here is also `404`.

## Shared results (public, read-only, no session)

Rate limited per IP address (2 requests per second).

| Method and path | Answer |
| --- | --- |
| `GET /api/shared?kind=&pdb=&q=&ids=&limit=` | `{ retentionDays, entries: [meta] }`, newest first. `kind` is `target`, `design` or `construct`; `pdb` a PDB ID; `q` words that must all match title, ids, candidate names, vector or session label; `ids` a comma-separated list; `limit` up to 100. |
| `GET /api/shared/<id>` | `{ meta, data }`; `404` once expired |
| `GET /api/shared/<id>/file/<name>` | a stored `.pdb` or `.fasta` as text; add `?download=1` for a download |

`meta` is `{ id, kind, title, pdbId, createdAt, expiresAt, summary, files, search }`.
Ids look like `design-<hex>`, `target-<PDB ID>`, `construct-<hex>`. Titles are
`<PDB ID> - <date time UTC> - session <label>` (designs) and
`<candidate> in <vector> - <date time UTC> - session <label>` (constructs).

To continue from someone's design, a session calls (with its cookie):

| Channel | `args` | Result |
| --- | --- | --- |
| `import-shared` | `[{ id }]` (a `design-...` id) | `{ id, pdbId, params, candidates }`: the structures are copied into this session's `work/shared_<id>/` and each candidate's `pdbPath` points there |

## Not exposed

The engine in `server/engine.js` still contains the desktop app's handlers for
pulling or building the tools image, settings files and folder dialogs. They are
registered but unreachable: `validate.js` allows only the channels above.
