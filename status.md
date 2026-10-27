# Project status: IpsenGPT

Handover notes for the next agent. Read with [PLAN.md](PLAN.md) (the spec), [CLAUDE.md](CLAUDE.md)
(working rules) and [README.md](README.md) (how to run and deploy). Last updated 2026-10-26.

## Working rules (from the user)

- Work in phases from PLAN.md. **Stop after each phase**, summarize, and say exactly how to test it.
- **The user makes all commits.** Never commit; when asked, provide a commit message (conventional
  style, ends with the `Co-Authored-By` line).
- If anything is uncertain, **ask** (multiple-choice question) rather than guess.
- Write meaningful tests and gates, and iterate until they pass. Suggestions are welcome.
- Deployment is **scripts + docs only**: the agent does not SSH into or change the droplet; the user runs it.

## Where things stand

| Phase | State | Commit |
| --- | --- | --- |
| 1. Core chat | done | `2a65cc9` |
| 2. Sessions & identity | done | `a21c5cf` |
| 3. Deployment | done locally; **not yet deployed to the real droplet** | `4be013c`, `ce13778`, `c7fb9ad` |
| 4. Photo gates | **built, waiting for the user's test**; accuracy on the 8b not measured yet (GPU was busy) | uncommitted |
| 5. Curses + live events | not started | |
| 6. Secrets game | not started (design must be confirmed by the user first) | |
| 7. Hardening & load tests | not started | |
| 8. Skin pass | not started | |

Gates at last run (2026-10-26, native Linux, after the switch to `chat.ipsen.no`): `pnpm check` passes
(typecheck, 199 server + 49 web tests, build) and `pnpm test:deploy` passes (all 7 suites, Phase 4 changes included).

## Decisions made with the user

- **Monorepo:** pnpm workspaces (pnpm 11), `apps/server` (Express 5 + TS) and `apps/web`
  (React 19 + Vite 8; guest app at `/`, admin at `/admin/` as a second Vite entry).
- **Persona** (`content/persona.md`) is a placeholder written by the agent (an LLM that died in a
  server-room fire); the user will rewrite it. It's re-read on every message.
- **Reserved names:** several guests may claim the same person in parallel. Approving one
  renames that session to the person's display name; the other claimants get a notice and must
  pick a new name.
- **Domain: `chat.ipsen.no`** (was `artifical.ipsen.no`; switched before the first real deploy). It must
  stay one level below `ipsen.no`, since Cloudflare's free edge certificate only covers `*.ipsen.no`. The
  Nginx site is a template (`__DOMAIN__`) filled in by `setup.sh --domain`.
- **Domain is behind Cloudflare** (orange cloud). TLS: certbot with the **Cloudflare DNS plugin**,
  SSL mode Full (strict). Nginx restores real IPs from `CF-Connecting-IP` (trusted from Cloudflare's
  ranges only). SSH and the tunnel must use the droplet IP or a DNS-only name, never `chat.ipsen.no`.
- **Droplet:** the `ipsen.no` host in the user's SSH config, fresh Ubuntu 24.04.
- **Images:** built on the PC and shipped with `docker save | ssh docker load` (no registry).
- **Fallback timeouts** (see `apps/server/src/ollama.ts`): connection refused → fall back at once;
  health check (`/api/version`) silent for 3 s → PC is dead, fall back; PC alive but no first
  token within 15 s → fall back. A failed primary is skipped for 30 s.
- **Models** (benchmarked by the user):

  | Machine | Model | Notes |
  | --- | --- | --- |
  | Gaming PC (party primary) | `qwen3-vl:8b-instruct` | 100% GPU, 5.8 GB, prompt 435 tok/s, generation 70 tok/s |
  | Native Linux laptop (testing) | `qwen3-vl:4b-instruct` | 8 GB RTX 2000 Ada: 8b only 86% on GPU (21.7 tok/s); 4b is 53.6 tok/s |
  | Droplet fallback | `llama3.2:1b` | CPU only, text only (photo gates must report "unverified") |

  The model **name** is set in the droplet's `.env` (`OLLAMA_MODEL`); the PC only needs it pulled.
  It's `qwen3-vl` with a lowercase L: the user once typed `qwen3-v1` and got "file does not exist".
  `OLLAMA_CONTEXT_LENGTH=4096` is pinned on the PC to match the app's `num_ctx`; a mismatch makes
  Ollama reload the model.

- **Photo gates (Phase 4), decided with the user:** verification at temperature 0. The user
  declined: a second "screen/printout" check, failing closed on bad JSON (it's "unverified" instead;
  it never unlocks either way), and revoking a passed gate. Admin *can* cancel an active gate.
  A `timed_global` gate blocks chat until passed or its deadline; at the deadline it just expires
  (no points). A failed photo shows the guest an in-character line **plus the model's reason**.
- Gate examples in `content/gates.json` are all `admin_forced`, so nothing blocks guests until the
  user picks triggers (still an open question in PLAN.md).

## Open items and pending confirmations

- **Phase 4 still to do (needs the GPU):** measure gate accuracy on the **8b** with real photos
  (right object, wrong object, a photo of a screen showing the object, the word written on paper).
  Tune `PHOTO_CONFIDENCE_MIN` (0.7) from that.
- **WSL setup the user still has to do** (needs sudo): run `deploy/pc/setup-ollama.sh qwen3-vl:8b-instruct`
  after gaming (it pins 5.8 GB of VRAM); install Docker Engine for `pnpm test:deploy`; create `.env`.
- A gate forced while a guest is idle only shows up on their next message or page load. Phase 5's
  SSE events should push it (and the countdown of a `timed_global` gate).
- `SSE_ROUTES` in `apps/server/src/sse.ts` lists `/api/events` for Phase 5. Nginx already has an
  unbuffered location for it.
- The guest page polls `/api/session` every 5 s while a claim is pending; Phase 5's SSE events
  should replace that.
- Points are stored per gate (`gates.points`, status `passed`) but nothing sums them yet (Phase 6).
- PLAN.md open questions still open: character voice, gate targets and triggers, person-file
  content, secrets game design.
- Real-droplet verification (README "Deployment → 4. Verify") hasn't happened yet. Nothing has
  been tested through Cloudflare.

## Moving to WSL2 (new environment)

The repo was developed on **native Ubuntu**. Things to check after cloning into WSL:

- Clone into the Linux filesystem (`~/code/...`), **not** `/mnt/c`: performance, file watching and
  permissions all suffer there.
- Node ≥ 22 (developed on 24.19) and pnpm 11 (`packageManager` pins 11.25.0). `pnpm install`
  compiles `better-sqlite3` from source if no prebuilt binary matches, which needs
  `python3 make g++`. `pnpm-workspace.yaml` already allows the esbuild and better-sqlite3 build scripts.
- `pnpm test:deploy` needs Docker, and several tests use `--network host` and bind ports on
  127.0.0.1. Docker Engine installed inside WSL works like native Linux. With **Docker Desktop**,
  host networking must be enabled (Settings → Resources → Network), or `test-nginx.sh`,
  `test-compose.sh` and `test-deploy.sh` will fail to reach their containers.
- GPU in WSL: do **not** install a Linux NVIDIA driver; `nvidia-smi` must work through the Windows
  driver. Ollama needs systemd enabled in `/etc/wsl.conf`. `deploy/pc/setup-ollama.sh` checks both.
- Local `.env` is gitignored; recreate it from `.env.example`. Set `ADMIN_PASSWORD` (8+ chars) to
  use `/admin/`.

## How to run (quick reference)

| Command | Purpose |
| --- | --- |
| `pnpm dev:mock` | Mock Ollama :11436 + server :3000 + Vite :5173 (no GPU needed) |
| `pnpm dev` | Same, against `OLLAMA_URL` in `.env` (real Ollama on :11434) |
| `pnpm check` | Gate: typecheck + all unit/integration tests + build |
| `pnpm test:deploy [suite...]` | Docker-based deploy tests: shellcheck nginx setup tunnel backup compose deploy |

To test fallback locally against the real model: `OLLAMA_URL=http://127.0.0.1:11434`,
`OLLAMA_FALLBACK_URL=http://127.0.0.1:11436`, run `pnpm --filter @ipsengpt/server mock:ollama` plus
`pnpm dev`, then `sudo systemctl stop ollama`.

## Code map

```
apps/server/src/
  index.ts, app.ts, services.ts   entry, Express wiring, service container (createServices)
  config.ts                       all .env parsing (zod); relative paths resolve against the .env dir
  ollama.ts                       streamChat: NDJSON streaming, health check + timeouts
  llm.ts                          primary/fallback routing, probe(), status for admin
  prompt.ts                       persona + extra system sections + trimmed history
  gateDefs.ts                     gates.json parsing (global + per person), re-read on every use
  gates.ts                        GateStore: triggers, force/cancel, expiry, timed gates; only it sets passed
  photos.ts                       magic-byte check, sharp resize/EXIF strip, PhotoStore (attempt records + files)
  verify.ts                       verification prompt, JSON schema, verdict parsing
  db.ts                           better-sqlite3, WAL, append-only MIGRATIONS (PRAGMA user_version)
  sessions.ts                     guest sessions, names, claims, messages (all identity rules)
  people.ts                       person folders on disk (person.md + gates.json), .trash on delete
  names.ts, claimCodes.ts         name validation/keys; BAT-427 codes (no O/I/L/0/1)
  rateLimit.ts, http.ts           sliding-window limiter, auth middleware, guest-safe views
  settings.ts, errorLog.ts        persisted admin switches (forceFallback), recent errors
  sse.ts                          SSE helper (heartbeat, X-Accel-Buffering), SSE_ROUTES
  admin/auth.ts                   admin cookie sessions (HttpOnly, Secure, SameSite=Strict)
  routes/{chat,session,admin}.ts  HTTP API (chat answers gated messages with refusals)
  routes/photos.ts                POST /api/photos/verify, PUT /api/photos/:id/original
  dev/mock-ollama*.ts             mock Ollama (reply/hang/delay/http_error/stream_error/truncate) + blackhole
apps/server/test/                 vitest + supertest; helpers.ts has makeEnv (in-memory DB, fake clock)
apps/web/src/                     guest app (App.tsx, components/, lib/sse.ts parser, lib/session.ts,
                                  components/GatePanel.tsx + lib/photos.ts for the photo flow)
apps/web/src/admin/               admin app: Claims, Sessions, Gates, Photos, People, System tabs
deploy/                           compose, env template, deploy.sh, droplet/ (setup, nginx, sshd,
                                  backup), pc/ (setup-ollama, tunnel), test/ (Docker test suites)
```

## Lessons learned (so the next agent doesn't repeat them)

- Ubuntu 24.04's Nginx is **1.24**: no `http2 on;` directive. Deploy tests pin `nginx:1.24-alpine`.
- `systemctl is-system-running` fails on "degraded" systems: detect systemd with `/run/systemd/system`.
  `ssh.service` is socket-activated on 24.04, so use `try-reload-or-restart`.
- sshd keeps the **first** value it reads: our drop-in is `10-ipsengpt.conf`, so it wins over `50-cloud-init.conf`.
- Express 5 non-strict routing matches `/admin/` for `app.get('/admin')`: check `req.path` exactly.
- Zod 4: defaults on transformed schemas need `.prefault()`.
- SVG comments can't contain `--`; browsers then refuse to render the file (`apps/web/src/assets.test.ts` guards this).
- Testing Library's `waitFor` uses faked timers too: with `vi.useFakeTimers`, advance time in a plain
  loop (see `afterPolling` in `App.test.tsx`).
- WSL2 `networkingMode=Mirrored` (this PC's setup): connecting to a closed port on `127.0.0.1` **hangs**
  instead of being refused; `127.0.0.2`, `::1` and the LAN IP still refuse. Also, `fetch` refuses
  "bad ports" (1, 9, ...) itself without connecting. Tests that need a refused connection use
  `refusedUrl()` in `apps/server/test/helpers.ts`. At runtime this only means a dead Ollama behind the
  tunnel falls back after the 3 s health check instead of at once.
- sharp's prebuilt binaries can't decode HEIC (only AVIF); such originals are stored as-is and flagged.
  It *can* decode SVG/GIF/TIFF, so the magic-byte check is what keeps those out.
- A per-session "one at a time" guard must be taken before the request body is read, or two
  uploads sent together both get in (`gateFlow.test.ts` stalls one upload mid-body to prove it).
- Verify that tests actually bite: several deploy tests passed for the wrong reason (header-only
  timing, `timeout` exit codes, case-sensitive header checks) until mutation-checked. When adding a
  safety test, temporarily break the code and confirm the test fails.
