# SadGPT

Halloween costume chatbot: SadGPT, a sad emo chatbot (formerly IpsenGPT; the repo and server paths keep
the old name). See [PLAN.md](PLAN.md) for the full spec.

```
apps/server   Express + TypeScript API (SSE chat streaming against Ollama)
apps/web      React + Vite frontend: guest chat at /, admin dashboard at /admin/
content/      personas/ (the shipped personas: copied into data/personas on first start; never sent to the client)
              gates.json (photo gates for everyone)
              people.example/ (an example person folder)
data/         runtime state, gitignored: SQLite DB, people/, photos/, personas/ (volumes in production)
deploy/       Docker Compose, Nginx, droplet + PC scripts, deploy tests (see Deployment)
```

## Development

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
cp .env.example .env
```

| Command | What it does |
| --- | --- |
| `pnpm dev:mock` | Mock Ollama (port 11436) + server (3000) + Vite (5173). Open http://localhost:5173 |
| `pnpm dev` | Server + Vite against the real `OLLAMA_URL` in `.env` |
| `pnpm check` | Gate: typecheck + all tests + production build |
| `pnpm build && pnpm start` | Production mode: server serves the built frontend on `PORT` |
| `pnpm test:deploy` | Deployment tests in Docker: shellcheck, Nginx, SSH tunnel, backups, compose, deploy.sh (~2 min) |
| `pnpm smoke:prod` | Smoke test of the live site from outside, as a guest (see "Verify on the real droplet") |

Test on a phone on the same network: `pnpm --filter @ipsengpt/web dev --host` and open the printed LAN URL.

Personas are edited in Admin → System and re-read on every message, so edits apply without a restart.

## Guests, claims and admin

- Guests pick a name (unique, case-insensitive). The session token lives in `localStorage`;
  history and state live in SQLite (`DB_PATH`).
- A name or alias of a pre-registered person starts a **claim**: the guest gets a code like
  `BAT-427`, can chat as a plain guest meanwhile, and shows the code to you. Several guests can
  claim the same person at once; approving one turns the others away.
- **Shared first names:** a display name belongs to one person, but several people can share an
  alias (e.g. "Vanessa" on both Vanessa Berg and Vanessa Hansen). A guest typing it gets a normal
  claim, and in Claims you tap **Approve as …** for the right one. The full names still claim just one person.
- **Invite links:** Admin → People → a person → **Make invite link** (Share/Copy). Whoever opens it
  first becomes that person, no claim code; it then stops working. Opened in a browser that already has
  a session, that session becomes the person and keeps its chat and points. **New link** replaces it,
  **Revoke** kills it. The token sits after the `#`, so it never reaches Nginx or Cloudflare logs.
- Admin: set `ADMIN_PASSWORD` in `.env`, open `/admin/` (in dev: http://localhost:5173/admin/).
  Claims (search by code, approve/reject), Sessions (chat log, assign person, release name,
  end session), People (create/edit/delete).
- People are folders in `PEOPLE_DIR` (default `data/people/`), see
  [content/people.example](content/people.example). Edit them by hand and press
  "Reload from disk", or edit in admin. Deleted people go to `PEOPLE_DIR/.trash/`.
  A person's info only reaches the model in their own chat, after their claim is approved.

## Personas

Edit them in **Admin → System → Edit personas**: name, description (only you see it) and the character,
plus **Shared rules**, which come **first** in every prompt: the language rule (English only), length,
safety, and "you can't give points". Deleted personas go to `.trash/`; the shipped ones
can be reset to their original text or added back.

On disk each persona is `<id>.md` (frontmatter `name`, `description`, then the character) in `PERSONAS_DIR`
(`data/personas`, a volume in production), next to `_rules.md`. It's party data: on first start the app
copies in the shipped ones from `content/personas/` (`PERSONAS_SEED_DIR`), and deploys never overwrite it.
The persona a guest gets:

1. their own, set in **Admin → Sessions** (any guest), else
2. the global one, picked in **Admin → System**, else
3. `DEFAULT_PERSONA` (`sadgpt`).

A person can get a persona in **Admin → People**, applied when their claim is approved or they are assigned:
- one from the list (`persona: <id>` in their `person.md`), or
- **Custom**: text written just for them (how SadGPT acts toward them), saved as `persona.md` in their
  folder. It comes after the shared rules and is used whenever their session has no persona picked in
  Sessions. It's separate from their "Info" (what SadGPT knows about them).

Switches apply from the guest's next message.

## Points, leaderboard and rewards

- Every point change is a row in a ledger with a reason. For now points come from **passed photo gates**
  (the gate's `points`) and from you: **Admin → Points** (or a guest's page in Sessions) gives or takes
  points with a reason the guest sees as a notice.
- Guests see their points in the header; tapping it opens the leaderboard (top 10 plus their own place)
  and the rewards. Named, live sessions with points take part; a tie goes to whoever got there first.
- **Rewards** are "first to N points". The first guest to reach N wins it automatically and for good;
  a reward added late still goes to whoever reached N first. Each has a **Show/Hide prize** switch:
  hidden prizes show as "???" to guests. The winner gets a notice.
- Everything updates live over `/api/events`.

## Photo gates

A gate blocks a guest's chat until they send a photo of something ("a pumpkin"). Only server code
unlocks it, after the vision model says yes with at least `PHOTO_CONFIDENCE_MIN` confidence.
Nothing typed in the chat can unlock it: while a gate is active, messages get an in-character refusal
and never reach the normal chat flow.

Gates are defined in [content/gates.json](content/gates.json) (everyone) and in
`PEOPLE_DIR/<slug>/gates.json` (only that person, once their claim is approved). Both are re-read on
every use, so edits apply without a restart; mistakes show up in Admin → Gates.

```json
{
  "id": "pumpkin",
  "target": "a pumpkin or a jack-o'-lantern",
  "guest_prompt": "Bring me a photo of a pumpkin before I say another word.",
  "refusal_lines": ["No pumpkin, no prophecy."],
  "points": 10,
  "trigger": { "type": "after_messages", "count": 5 }
}
```

| `trigger.type` | When |
| --- | --- |
| `session_start` | Before a new guest can chat. In a person's file: when their claim is approved. |
| `after_messages` | Right after the reply to the guest's `count`th message, so it shows up before they type again. |
| `timed_global` | At `at` (ISO time **with timezone**, e.g. `2026-10-31T22:30:00+01:00`), for every guest, until `deadline_minutes` later. Then it expires; whoever didn't make it misses the points. |
| `admin_forced` | Only when you force it in admin. |
| `curse_break`, `secret_level` | Reserved for curses (Phase 6) and the secrets game (Phase 7). |

- `target` goes into the verification prompt: describe what the camera should see.
- `refusal_lines` are used in turn. Leave it empty to let the model make up refusals.
- Each triggered gate fires once per guest. You can force any gate again.
- Gates reach guests the moment they start (forced, timed or triggered) over the live event stream
  (`/api/events`), so nobody's message is spent on discovering a gate. Anything typed while a gate is
  active gets a refusal.

**Admin → Gates:** force a gate (or a custom one you type in) on one guest or everyone, with an
optional deadline; cancel active gates (for example if the PC is down and nobody can pass).
**Admin → Photos:** every attempt (passed, failed, unverified) with what the model saw; open,
download or delete. Photos are never served to guests.

**Upload flow:** the guest ticks the consent box, takes a photo, and the browser sends a 768 px copy
for verification. After the verdict it uploads the original (up to 20 MB) in the background.
The server checks file types by their bytes, turns photos upright, and strips EXIF (GPS, device).
HEIC files the server can't decode are kept as uploaded and flagged in admin.

**Verification** uses the PC's model at temperature 0, with a JSON schema. If the PC is
unreachable, photos are "unverified" and the guest can retry. Photos are still verified while chat is paused. Rate limit: one photo
per guest per 15 s (`RATE_PHOTO_SESSION`).

With `pnpm dev:mock`, the mock model fails every other photo (`MOCK_OLLAMA_VERDICT=cycle`; also
`pass`, `fail`, `bad`).

## Theming

Every color, font, bubble style, background image and the portrait is a CSS custom property in
[apps/web/src/theme.css](apps/web/src/theme.css). To swap the portrait/logo, put the file in
`apps/web/public/` and change `--portrait-image`.

## Deployment

```
guest phone ──HTTPS──▶ Cloudflare ──HTTPS──▶ droplet: Nginx ──▶ app 127.0.0.1:3000 (Docker, host network)
                                                                  └─ 127.0.0.1:11435 ─ssh tunnel─▶ PC Ollama
```

There is one model, on the PC. **While it can't be reached, chat is closed**: guests see a banner
("SadGPT has gone quiet and needs a moment alone…") and can't send, and it reopens by itself when the
PC is back. Guests get these changes live over `/api/events`.
- **Checked every `OLLAMA_CHECK_INTERVAL_MS`** (5 s): the PC must answer and have `OLLAMA_MODEL` pulled.
- **PC unreachable** (tunnel down, Ollama stopped) during a reply: that reply fails and chat closes at once.
- **PC dead but tunnel still up** (asleep or hung): a health check sent with each request gets no
  answer within `OLLAMA_CONNECT_TIMEOUT_MS` (3 s); chat closes.
- **PC alive but busy** (queued guests): the app waits up to `OLLAMA_FIRST_TOKEN_TIMEOUT_MS` (45 s)
  for the reply to start. If it doesn't, that reply fails, but chat stays open.

**Admin → System** shows whether the PC is connected, what guests see, how many pages are open, and
recent errors. **Pause chat** closes it for everyone with a reason you type (e.g. during speeches);
guests see your text in the banner until you resume. It survives restarts.

| File | Runs on | Purpose |
| --- | --- | --- |
| [Dockerfile](Dockerfile) | PC | Multi-stage image (built off the droplet) |
| [deploy/deploy.sh](deploy/deploy.sh) | PC | Build, ship image over SSH, sync, restart, wait for health |
| [deploy/pc/setup-ollama.sh](deploy/pc/setup-ollama.sh) | PC | Ollama service with `OLLAMA_KEEP_ALIVE=-1`, pull + warm model |
| [deploy/pc/tunnel.sh](deploy/pc/tunnel.sh) | PC | Reverse tunnel with reconnect loop |
| [deploy/droplet/setup.sh](deploy/droplet/setup.sh) | droplet | Swap, users, sshd, ufw, Docker, Nginx, certbot, backup cron |
| [deploy/docker-compose.yml](deploy/docker-compose.yml) | droplet | The app |
| [deploy/env.production.example](deploy/env.production.example) | droplet | Template for `/srv/ipsengpt/app/.env` |

### 0. Cloudflare

- DNS: a **proxied** (orange cloud) `A` record `chat` → the droplet's IP. Keep the name one level
  below `ipsen.no`: Cloudflare's free edge certificate covers `*.ipsen.no` only, so a name like
  `chat.open.ipsen.no` would show guests a certificate error. Another hostname works with
  `setup.sh --domain <name>`.
- SSL/TLS mode: **Full (strict)**. The origin gets a Let's Encrypt cert through the DNS challenge.
- Create an API token: *My Profile → API Tokens → Create Token → Edit zone DNS*, limited to
  the `ipsen.no` zone. `setup.sh` asks for it once and stores it in `/root/.secrets/cloudflare.ini` (mode 600).
- Keep Rocket Loader and Bot Fight Mode **off** for this hostname; they interfere with the app's API calls.
- SSH and the tunnel can't go through the proxied name. Use the droplet's IP, or add a
  DNS-only (grey cloud) record such as `ssh.ipsen.no`.

### 1. PC: model and tunnel (native Ubuntu or WSL2)

WSL2 only:
- **Don't** install an NVIDIA driver inside WSL; the Windows driver provides CUDA. `nvidia-smi` must work in WSL.
- Enable systemd: put `[boot]` / `systemd=true` in `/etc/wsl.conf`, then run `wsl --shutdown` from Windows.
- Keep the repo and models on the Linux filesystem (`~/...`), not under `/mnt/c`.

Both:
```bash
deploy/pc/setup-ollama.sh qwen3-vl:4b-instruct
```
```bash
ssh-keygen -t ed25519 -N '' -C ipsengpt-tunnel -f ~/.ssh/ipsengpt_tunnel
```
```bash
mkdir -p ~/.config/ipsengpt && echo 'TUNNEL_HOST=<droplet-ip>' > ~/.config/ipsengpt/tunnel.env
```
Note it's `qwen3-vl` with a lowercase L ("vision-language"). On the 8 GB RTX 2000 laptop,
`qwen3-vl:8b` only partly fits on the GPU: 21.7 tokens/s and slow prompt reading. `qwen3-vl:4b` runs
entirely on the GPU at 53.6 tokens/s. With 12 GB of VRAM or more, the 8b is an option. Check
`ollama ps`: you want `100% GPU`.

### 2. Droplet: one-time setup (as root, fresh Ubuntu 24.04)

```bash
scp -r deploy/droplet root@<droplet-ip>:/root/ipsengpt-setup
```
```bash
ssh -t root@<droplet-ip> "/root/ipsengpt-setup/setup.sh --admin-user <you> --email <you@example.com> --tunnel-key '$(cat ~/.ssh/ipsengpt_tunnel.pub)'"
```
Mind the quotes: ssh joins its arguments and the droplet's shell splits them again, so the key needs its
own (single) quotes inside the remote command, or its parts arrive as separate options. If the key is on
another machine, paste the `.pub` line between the single quotes instead of `$(cat ...)`. `-t` keeps the
Cloudflare token prompt hidden.
This creates a 2 GB swap file and an admin user `<you>` with root's SSH keys and sudo. It adds the
`tunnel` user (no shell; the key can only listen on `127.0.0.1:11435`) and turns off SSH passwords
and `GatewayPorts`. It enables ufw with only 22/80/443 open, installs Docker, Nginx and certbot,
issues the certificate, sets up Cloudflare real-IP restoration, and adds an hourly backup cron job.
It's safe to re-run; skip steps with `--skip <step>`.
Once `ssh <you>@<droplet-ip>` works, you can set `PermitRootLogin no` in
`/etc/ssh/sshd_config.d/10-ipsengpt.conf`.

Then create the app config:
```bash
scp deploy/env.production.example <you>@<droplet-ip>:/srv/ipsengpt/app/.env
```
```bash
ssh -t <you>@<droplet-ip> 'chmod 600 /srv/ipsengpt/app/.env && nano /srv/ipsengpt/app/.env'
```
Set `ADMIN_PASSWORD` (`openssl rand -base64 18`) and check the model names.

### 3. Deploy (from the PC; repeat for every update)

```bash
deploy/deploy.sh <you>@<droplet-ip>
```
This runs `pnpm check`, builds `ipsengpt:<git-sha>`, streams it to the droplet with
`docker save | ssh docker load`, syncs the compose file and gates, and runs `docker compose up -d`.
Personas are not synced: they're edited in admin and live in `/srv/ipsengpt/personas/`, which deploy.sh
creates (for the app's user) if setup.sh predates it.
It then waits for `/api/health`.
**Rollback:** set `IPSENGPT_TAG=<previous>` (printed by deploy.sh) in `/srv/ipsengpt/app/.env`, then
`docker compose up -d`.

On the droplet, `/srv/ipsengpt/` holds `app/` (compose, `.env`, `content/gates.json`), `db/`,
`people/`, `photos/`, `personas/` and `backups/`. Data lives in bind mounts, so `up --build`, redeploys and
container restarts never touch it.

### 4. Verify on the real droplet

```bash
curl -s https://chat.ipsen.no/api/health
```
```bash
ssh <you>@<droplet-ip> 'sudo ss -ltnp | grep -v 127.0.0. ; sudo ufw status'
```
1. The health check returns `{"ok":true}`. The only public listeners are sshd (22) and Nginx (80/443). Ports 3000 and 11435 appear only on 127.0.0.1.
2. Start `deploy/pc/tunnel.sh`, open the site, and chat. Admin → System shows the model **Connected**.
3. A reply streams word by word through Cloudflare. If it arrives all at once, something buffers SSE.
4. Stop the tunnel (Ctrl-C). Within about 5 s the phone shows the "lost contact" banner and can't send.
   Restart the tunnel; within about 5 s the banner goes away by itself.
5. In Admin → Sessions, a guest's last-seen is correct and rate limits are per guest: each phone has its
   own IP in the app, not Cloudflare's.

Then the smoke test, from any machine (Python 3, standard library only):
```bash
pnpm smoke:prod --origin <droplet-ip>
```
It checks Cloudflare and TLS, the origin certificate and closed ports, the guest flow, the live event
stream, streaming replies, one-reply-at-a-time, the rate limit and the size limit. It creates guests
named "Smoke Test <n>" and sends about ten short chats; end them in Admin → Sessions afterwards.
`--no-chat` leaves the model alone.

### Backups and restore

Hourly at :05 to `/srv/ipsengpt/backups/<UTC timestamp>/` (keeps 72). Each one holds a consistent
SQLite snapshot plus `people/` and `photos/`; unchanged photos are hard-linked, so they take no extra
space. Log: `/var/log/ipsengpt-backup.log`. Run one now with `sudo ipsengpt-backup`.

To restore (on the droplet, in `/srv/ipsengpt/app`):
```bash
docker compose stop app
```
```bash
sudo cp ../backups/<stamp>/ipsengpt.sqlite ../db/ipsengpt.sqlite && sudo rm -f ../db/ipsengpt.sqlite-wal ../db/ipsengpt.sqlite-shm && sudo chown 1000:1000 ../db/ipsengpt.sqlite
```
```bash
docker compose start app
```

### Day-to-day

- Logs: `docker compose logs -f app` (in `/srv/ipsengpt/app`).
- Personas: switch in Admin → System (everyone) or Sessions (one guest); edit them in Admin → System.
  Live on the next message. A new shipped persona in the repo shows up under "Deleted defaults" to add.
- People: edit `/srv/ipsengpt/people/<slug>/person.md`, then Admin → People → *Reload from disk*.
- Gates: edit `/srv/ipsengpt/app/content/gates.json` or `/srv/ipsengpt/people/<slug>/gates.json`. Live on next use
  (deploy.sh overwrites `content/gates.json` with the repo version).

### Party checklist (PC)

- Windows: `powercfg.exe /change standby-timeout-ac 0` (no sleep). Pause Windows Update for a week in Settings.
- Linux laptop: plug it in and disable suspend (Settings → Power, or `systemctl mask sleep.target suspend.target`).
- Close games, Steam and other GPU-heavy apps. Check `ollama ps`: the model shows as loaded `Forever`.
- Run `deploy/pc/tunnel.sh` in a terminal that stays open all night (on Windows this also keeps WSL alive).
- Admin → System: model **Connected**, and chat not paused.
