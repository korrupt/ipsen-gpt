# IpsenGPT

Halloween costume chatbot. See [PLAN.md](PLAN.md) for the full spec.

```
apps/server   Express + TypeScript API (SSE chat streaming against Ollama)
apps/web      React + Vite frontend: guest chat at /, admin dashboard at /admin/
content/      persona.md (the system prompt, never sent to the client)
              people.example/ (an example person folder)
data/         runtime state, gitignored: SQLite DB + people/ (volumes in production)
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

Test on a phone on the same network: `pnpm --filter @ipsengpt/web dev --host` and open the printed LAN URL.

The persona (`content/persona.md`) is re-read on every message, so edits apply without a restart.

## Guests, claims and admin

- Guests pick a name (unique, case-insensitive). The session token lives in `localStorage`;
  history and state live in SQLite (`DB_PATH`).
- A name or alias of a pre-registered person starts a **claim**: the guest gets a code like
  `BAT-427`, can chat as a plain guest meanwhile, and shows the code to you. Several guests can
  claim the same person at once; approving one turns the others away.
- Admin: set `ADMIN_PASSWORD` in `.env`, open `/admin/` (in dev: http://localhost:5173/admin/).
  Claims (search by code, approve/reject), Sessions (chat log, assign person, release name,
  end session), People (create/edit/delete).
- People are folders in `PEOPLE_DIR` (default `data/people/`), see
  [content/people.example](content/people.example). Edit them by hand and press
  "Reload from disk", or edit in admin. Deleted people go to `PEOPLE_DIR/.trash/`.
  A person's info only reaches the model in their own chat, after their claim is approved.

## Theming

Every color, font, bubble style, background image and the portrait is a CSS custom property in
[apps/web/src/theme.css](apps/web/src/theme.css). To swap the portrait/logo, put the file in
`apps/web/public/` and change `--portrait-image`.

## Deployment

```
guest phone ──HTTPS──▶ Cloudflare ──HTTPS──▶ droplet: Nginx ──▶ app 127.0.0.1:3000 (Docker, host network)
                                                                  ├─ primary  127.0.0.1:11435 ─ssh tunnel─▶ PC Ollama
                                                                  └─ fallback 127.0.0.1:11434 ─ ollama container
```

The app uses the PC's model and falls back to the droplet's small model when the PC can't answer:
- **PC unreachable** (tunnel down, Ollama stopped): fallback immediately.
- **PC dead but tunnel still up** (asleep or hung): a health check sent with each request gets no
  answer, so the app falls back after `OLLAMA_CONNECT_TIMEOUT_MS` (3 s).
- **PC alive but busy** (queued guests): the app keeps waiting for up to `OLLAMA_FIRST_TOKEN_TIMEOUT_MS`
  (15 s), then falls back.

After any failure it skips the PC for `OLLAMA_PRIMARY_RETRY_MS` (30 s) before trying it again.
Admin → System shows both models, lets you force the fallback, and lists recent errors.

| File | Runs on | Purpose |
| --- | --- | --- |
| [Dockerfile](Dockerfile) | PC | Multi-stage image (built off the droplet) |
| [deploy/deploy.sh](deploy/deploy.sh) | PC | Build, ship image over SSH, sync, restart, wait for health |
| [deploy/pc/setup-ollama.sh](deploy/pc/setup-ollama.sh) | PC | Ollama service with `OLLAMA_KEEP_ALIVE=-1`, pull + warm model |
| [deploy/pc/tunnel.sh](deploy/pc/tunnel.sh) | PC | Reverse tunnel with reconnect loop |
| [deploy/droplet/setup.sh](deploy/droplet/setup.sh) | droplet | Swap, users, sshd, ufw, Docker, Nginx, certbot, backup cron |
| [deploy/docker-compose.yml](deploy/docker-compose.yml) | droplet | App + fallback Ollama |
| [deploy/env.production.example](deploy/env.production.example) | droplet | Template for `/srv/ipsengpt/app/.env` |

### 0. Cloudflare

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
ssh root@<droplet-ip> /root/ipsengpt-setup/setup.sh --admin-user <you> --email <you@example.com> --tunnel-key "$(cat ~/.ssh/ipsengpt_tunnel.pub)"
```
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
`docker save | ssh docker load`, syncs the compose file and persona, and runs `docker compose up -d`.
The first deploy also pulls the fallback model. It then waits for `/api/health`.
**Rollback:** set `IPSENGPT_TAG=<previous>` (printed by deploy.sh) in `/srv/ipsengpt/app/.env`, then
`docker compose up -d`.

On the droplet, `/srv/ipsengpt/` holds `app/` (compose, `.env`, `content/persona.md`), `db/`,
`people/`, `photos/` and `backups/`. Data lives in bind mounts, so `up --build`, redeploys and
container restarts never touch it.

### 4. Verify on the real droplet

```bash
curl -s https://artifical.ipsen.no/api/health
```
```bash
ssh <you>@<droplet-ip> 'sudo ss -ltnp | grep -v 127.0.0. ; sudo ufw status'
```
1. The health check returns `{"ok":true}`. The only public listeners are sshd (22) and Nginx (80/443). Ports 3000, 11434 and 11435 appear only on 127.0.0.1.
2. Start `deploy/pc/tunnel.sh`, open the site, and chat. Admin → System shows **Primary: Ready**.
3. A reply streams word by word through Cloudflare. If it arrives all at once, something buffers SSE.
4. Stop the tunnel (Ctrl-C) and chat again: you get a reply from the fallback (small model) right away,
   and System shows it answering. Restart the tunnel; within 30 s the primary is used again.
5. In Admin → Sessions, a guest's last-seen is correct and rate limits are per guest: each phone has its
   own IP in the app, not Cloudflare's.

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
- Persona: edit `/srv/ipsengpt/app/content/persona.md`. It's live on the next message (deploy.sh overwrites it with the repo version).
- People: edit `/srv/ipsengpt/people/<slug>/person.md`, then Admin → People → *Reload from disk*.

### Party checklist (PC)

- Windows: `powercfg.exe /change standby-timeout-ac 0` (no sleep). Pause Windows Update for a week in Settings.
- Linux laptop: plug it in and disable suspend (Settings → Power, or `systemctl mask sleep.target suspend.target`).
- Close games, Steam and other GPU-heavy apps. Check `ollama ps`: the model shows as loaded `Forever`.
- Run `deploy/pc/tunnel.sh` in a terminal that stays open all night (on Windows this also keeps WSL alive).
- Admin → System: Primary **Ready**.
