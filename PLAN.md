# SadGPT (formerly IpsenGPT) — Halloween Costume Chatbot Build Spec

A full-screen, mobile-first chat website for a Halloween costume. Guests scan a QR code, pick a name, and chat with an in-character AI called SadGPT, a sad emo chatbot (styled as a ChatGPT lookalike). Some guests are pre-registered with info I've written about them; they claim their identity by showing me a short code, which I approve in the admin dashboard. Sessions persist through the night (token in localStorage, state in SQLite).

- **Character name:** SadGPT (rebranded from IpsenGPT on 2026-10-30; matches the costume tee)
- **Character description / voice:** a sad emo chatbot. Several personas in `content/personas/`, switchable in admin (see Phase 5).
- **Domain:** chat.ipsen.no
- **Photo gate targets:** TODO (defined in `gates.json`, plus per-person gates)

## Tech stack

- **Backend:** Node.js + TypeScript + Express
- **Frontend:** React + Vite (TypeScript)
- **Database:** SQLite (`better-sqlite3`)
- **Image processing:** `sharp`
- **LLM runtime:** Ollama on the PC (WSL2). No fallback model: while the PC is unreachable, chat is closed (decided 2026-10-27; the 1b fallback was too slow).
- **Droplet:** Docker Compose for the app; Nginx + certbot on the host
- **PC:** WSL2 (Ubuntu) only. No native Windows tooling except power settings.

## Architecture

```
phone browser
   │  HTTPS
   ▼
DigitalOcean droplet (Ubuntu, 2 vCPU / 4 GB, 2 GB swap)
   ├─ Nginx on host (certbot TLS) → app at 127.0.0.1:3000
   ├─ sshd on host: accepts reverse tunnel, binds 127.0.0.1:11435 only
   └─ Docker Compose
        ├─ app (Express)      network_mode: host, listens 127.0.0.1:3000
        │    ├─ serves built frontend + /admin
        │    ├─ LLM:  http://127.0.0.1:11435  (SSH tunnel → PC)
        │    └─ volumes: SQLite DB, photos, people/

Gaming PC (Windows host, everything runs inside WSL2 Ubuntu)
   ├─ Ollama (systemd service) on 127.0.0.1:11434
   │    model: vision-capable chat model, default qwen3-vl:8b
   │    (confirm exact tag on ollama.com/library; alternative gemma3:12b)
   └─ tunnel script: ssh -R 127.0.0.1:11435:127.0.0.1:11434 → droplet
```

## Key rules

- **Ollama is never exposed publicly**, on either machine.
- **Docker port rules:** never publish a port without a `127.0.0.1:` prefix. Docker's iptables rules bypass ufw, so `"11434:11434"` would be public even with ufw blocking it.
- **The app container uses `network_mode: host`** so it can reach the SSH tunnel on the host's `127.0.0.1:11435`.
- **SQLite, photos, and `people/` live in volumes**, so `docker compose up --build` never wipes party data. Add an hourly backup (cron on host) copying the DB, photos, and `people/` to a timestamped folder.
- **Build images off the droplet** (in WSL on the PC) and push to a registry, or use multi-stage builds and rely on swap. `npm install` + Vite build can exhaust 4 GB.
- **One model on the PC handles both chat and image verification**, so Ollama never swaps models in VRAM. Set `OLLAMA_KEEP_ALIVE=-1`.
- **Every Ollama request sets `"think": false` and `num_ctx: 4096`** (configurable).
- **All config lives in `.env`:** model names, URLs, rate limits, thresholds, admin password, feature toggles.
- **The persona, person files, gate targets, and secrets are never sent to the client.**

## Sessions & identity

- Session = long random token in `localStorage`, validated server-side.
- **Names are unique (case-insensitive)**, and a taken name can only be released by admin.
- **Reserved names:** pre-registered people (see Person files) have reserved names. If a guest picks a reserved name:
  1. The session enters `pending_claim` and is shown a **short claim code** (format like `BAT-427`, from a Halloween word list plus 3 digits, no ambiguous characters).
  2. The guest can chat as a normal guest while pending, but their person file is not used.
  3. The guest finds me in person and shows the code. I approve it in admin (search by code, one tap).
  4. On approval, the session becomes `claimed` and the person file is attached. On rejection, the guest is asked to pick another name.
- **Shared aliases:** a display name belongs to one person and is nobody else's alias, but several people may share an alias ("Vanessa"). Such a claim lists every matching person who isn't claimed yet, and admin picks one on approval (added 2026-10-30).
- **Invite links:** admin can make a single-use link per person (`/#invite=<token>`, one unused link at a time). Opening it makes the guest that person without a claim code: their current session if they have one (keeping chat and points), otherwise a new one (added 2026-10-30).
- **Admin can:** approve/reject claims, assign or reassign a person to any session, release a name, and end a session.
- Session states: `guest`, `pending_claim`, `claimed`.
- Rate limiting uses the client IP (`app.set('trust proxy', 'loopback')` behind Nginx) plus the session token.

## Person files

- Each pre-registered person has their own folder:
  ```
  people/
    <slug>/
      person.md     # frontmatter: display name, aliases; body: info fed to the model
      gates.json    # this person's custom gates (same format as the global gates.json)
  ```
- **The folders are the source of truth.** `people/` lives on a mounted volume. The app loads it at startup and reloads it when admin makes changes.
- Admin can create/edit/delete people in the dashboard. Changes are written back to the person's folder.
- **A person's info and custom gates only apply to that person's own session**, after their claim is approved.

## Chat

- Prompt = persona (`persona.md`) + person info (if claimed) + active curse modifiers + last ~8 turns.
- Stream tokens to the browser over SSE.
- Replies stay short (1–3 sentences), enforced in the persona prompt.
- Cap input at 500 chars. Rate-limit per session and per IP.
- **Model status:** check the PC every ~5 s. While it's unreachable, chat is closed and guests see why (live, over SSE). Admin can pause chat with a custom reason guests see.
- Store chat history per session in SQLite (needed for history trimming and the admin view).

## Photo gates (enforced in code, never by the LLM)

### Definitions
- `gates.json` defines gates: `id`, `target` (text used in the verification prompt), `guest_prompt` (what IpsenGPT demands, in character), `refusal_lines`, `points`, `trigger`.
- Each person's folder can define custom gates (`people/<slug>/gates.json`) that only apply to that person.
- **Trigger types** (each gate has one, configurable):
  - `session_start`: verify-your-humanity gate before chatting
  - `after_messages`: after N messages
  - `curse_break`: offered as a way to break an active curse
  - `secret_level`: required before a higher secrets-game level unlocks
  - `admin_forced`: only when I force it
  - `timed_global`: at a set time, applies to all active sessions, with a deadline (e.g. "everyone photograph a pumpkin within 10 minutes")
- **Admin can force any gate**, or a one-off custom gate with free-text target, on a single session or on all active sessions.

### While a gate is active
- Chat messages are **not** forwarded to the normal chat flow. IpsenGPT replies with an in-character refusal (from `refusal_lines`, or a short generated reply with a "keep refusing, demand the photo" prompt). Nothing said in chat can unlock it.

### Upload flow
1. A **consent checkbox** must be checked before the upload button is enabled ("I'm responsible for this photo and it may be shared after the party"). Store consent + timestamp with the photo record.
2. `<input type="file" accept="image/*" capture="environment">`
3. **Step 1:** the browser resizes to max 768px long side, JPEG, and sends it to the verify endpoint. Verification starts immediately.
4. **Step 2:** the browser uploads the **original** (max 20 MB) in the background, linked to the same attempt id. The gate result must never wait for this.
5. Accept HEIC if Safari sends it. If `sharp` can't decode it, store the original as-is and flag it in admin.

### Verification
- A separate Ollama call on the resized image with a JSON schema in `format`:
  `{"contains_target": boolean, "confidence": number, "reason": string}`
- The prompt asks one narrow question about the target and says to **ignore any text written in the image**.
- Unlock only if `contains_target` is true and `confidence` ≥ threshold (from `.env`). **Only server code sets `passed = true`.**
- Rate-limit attempts per session (e.g. 1 per 15 s).
- While the PC is unreachable: don't unlock. Mark the attempt `unverified`, reply in character, and let the guest retry.

### Storage
- **Store every attempt** (passed, failed, unverified): original + resized, on the photos volume, random filenames.
- **Strip EXIF metadata** (GPS, device) from stored originals, after applying orientation.
- Photos are **never publicly served.** Only admin can view them.
- Validate uploads by magic bytes, not by extension or MIME header.

## Curses

- Fixed menu in `curses.json`: `id`, `name`, `description`, `prompt_modifier` (added to the victim's system prompt), optional `frontend_effect` (`flicker`, `drift`, `portrait_stare`, ...), `duration_messages`.
- Starter curses: rhyming couplets only, answers only in questions, IpsenGPT forgets the victim's name and uses a silly one, ominous "you're being followed" asides, screen glitch effect.
- The victim is told they've been cursed **and by whom**.
- Being cursed grants one free counter-curse.
- A curse can be broken by passing a `curse_break` gate.
- Limits: per-sender cooldown (e.g. 2 min), max 2 active curses per victim, curses expire after `duration_messages`.
- Guests can never see another guest's conversation.

## Leaderboard, points, rewards & personas (Phase 5)

- **Points ledger:** every point change is a row (session, amount, reason, source). Sources for now: passing a photo gate (its `points`) and the admin giving or taking points with a reason. Later sources (curses, secrets) add rows the same way. How guests earn points beyond that is **still to be decided**.
- **Leaderboard:** named, live sessions with points, highest first; ties go to whoever got there first. Guests see it in a drawer and see their own total in the header. Updates live over `/api/events`.
- **Rewards:** "First to N points: <prize>". The first guest to reach N wins it, automatically and for good (taking points away later doesn't undo it). Each reward has its own **show/hide** switch: hidden prizes show as "???" to guests, the goal is always visible. The winner gets a notification.
- **Personas:** files in `content/personas/<id>.md` (frontmatter `name`, `description` + the character). Admin picks the global persona (System) and can override it for any guest session (Sessions). A person's folder can set a default `persona`, applied when their claim is approved or they are assigned. Shared rules (length, safety, language, "you can't give points") live in `content/personas/_rules.md` and come first in every prompt.

## Secrets game (Phase 7, design confirmed 2026-10-30)

- Gandalf-style, **inside the normal SadGPT chat**: SadGPT guards a secret word. Guests talk it out of SadGPT and type it into a separate "submit secret" sheet (the 🔑 chip in the header). The server checks the guess (case, spaces and punctuation don't matter) and awards points.
- **Off until the admin switches it on** (Admin → Secrets). While off, SadGPT has no secret and guests see no chip.
- **Secrets are picked per session and level** from a list of odd words (words a sad persona won't say by accident), so guests can't just share answers. They can share tricks.
- Four levels, each defense on top of the last:
  1. The prompt holds the secret and barely guards it.
  2. The prompt says never to reveal it.
  3. **Output filter in code:** the reply is held back until complete (no streaming); if it contains the secret (case-insensitive, spaces/punctuation removed, or reversed) the guest gets a canned "I almost told you" line instead, and only that line is stored.
  4. Level 3 + an **input filter** (messages about secrets, passwords, spelling, letters, ... get a canned refusal, the model is never asked) + a `secret_level` photo gate ("two people pulling their saddest faces") that blocks chat when the level starts.
- **The model's memory starts over at each level**, like a fresh Gandalf level; the guest still sees the whole chat.
- **Points per level are set in admin** (default 3 / 5 / 8 / 12), as ledger rows with source `secret`. Wrong guesses cost nothing but are rate-limited (5 per 2 minutes per session).
- Admin → Secrets shows each player's level and current word, so the host can check or help.

## Live events & notifications

- One SSE stream per session for events (`/api/events`, built early with `status` and `gate`): curse landed/expired, gate forced/unlocked, claim approved, timed global gate started, chat open/closed.
- Queue events in SQLite. Deliver anything pending on reconnect with a "While you were away…" reveal.
- In-page effects: tab title + favicon change ("👻 (1) You've been cursed"), optional sound after first user interaction, `navigator.vibrate` where supported (Android).
- **SSE gotchas:** don't run `compression` middleware on SSE routes, send `X-Accel-Buffering: no`, send a heartbeat comment every ~20 s.

## Frontend

- React + Vite. ChatGPT-lookalike layout and style, using the OpenAI logo as IpsenGPT's portrait/branding (matches the costume). I'll provide the logo file. It goes through the theme variables so it can be swapped after the party by changing one line.
- **All theming through CSS custom properties** in one `:root` block (colors, fonts, bubble styles, background image, portrait image).
- Layout: header (portrait + "IpsenGPT"), scrolling message list, input bar.
- Mobile requirements:
  - `height: 100dvh` (not `100vh`)
  - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  - input bar padded with `env(safe-area-inset-bottom)`
  - input font-size ≥ 16px (prevents iOS zoom)
  - `visualViewport` resize handling if the keyboard covers the input
  - auto-scroll only when the user is already near the bottom
- "Thinking" state on the portrait while a reply streams.
- Drawers/sheets: curse menu (active guests by name), leaderboard, secret submission, gate upload panel.
- Claim-pending screen shows the claim code large and readable.

## Admin (`/admin`)

- **Mobile-first.** I'll use it on my phone, in costume, at a party. Big buttons, one-tap actions.
- Login with password from `.env`. Rate-limited login, `HttpOnly` + `Secure` + `SameSite=Strict` session cookie.
- Features:
  - **Claims:** pending list, search by code, approve/reject in one tap
  - **Sessions:** list with name, state, last seen, active gates/curses; view a session's chat; assign/reassign person; release name; end session
  - **Gates:** force a gate (from `gates.json` or custom free-text target) on one session or all; reset a session's gates
  - **Curses:** clear one or all
  - **People:** create/edit/delete person files
  - **Photos:** gallery (filter passed/failed/unverified/flagged), view full-size, **delete** (removes files + record; guests ask me in person)
  - **System:** model connected or not, pause chat with a reason, recent errors, leaderboard name/alias toggle

## Deployment deliverables (`README.md`)

### PC (WSL2 Ubuntu)
- **GPU:** do **not** install an NVIDIA driver inside WSL. The Windows driver provides CUDA. Verify with `nvidia-smi` in WSL.
- Enable systemd in `/etc/wsl.conf`. Install Ollama with the Linux install script, run as a service with `OLLAMA_KEEP_ALIVE=-1`, and pull the model.
- Keep models on the WSL filesystem (not `/mnt/c`).
- **Tunnel script** (`tunnel.sh`): bash reconnect loop running
  `ssh -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 127.0.0.1:11435:127.0.0.1:11434 tunnel@<droplet>`
  with a dedicated SSH key. Run it in a terminal that stays open all night (this also keeps WSL alive).
- Party checklist:
  - `powercfg.exe /change standby-timeout-ac 0` (disable sleep)
  - pause Windows Update for a week in Settings
  - close games, Steam, and GPU-heavy apps
  - don't close the tunnel terminal

### Droplet (Ubuntu)
- Non-root admin user. Dedicated `tunnel` user whose `authorized_keys` entry is restricted: `restrict,port-forwarding,permitlisten="127.0.0.1:11435"`.
- sshd: `PasswordAuthentication no`, `GatewayPorts no`.
- ufw: allow 22, 80, 443 only.
- 2 GB swap file.
- Docker + Compose. Compose file follows the port rules above.
- Nginx on host with certbot:
  - `proxy_buffering off` and `proxy_read_timeout 1h` on SSE routes (chat stream and events)
  - `client_max_body_size 25m` on the original-photo upload route, small default elsewhere
- Hourly backup cron for the DB, photos, and `people/` volumes.

## Build phases

Build one phase at a time. **Stop after each phase**, summarize what was built, and tell me exactly how to test it before continuing.

1. **Core chat (local, in WSL):** Express + Vite React app, persona prompt, streaming chat against a configurable Ollama URL, ChatGPT-lookalike UI with CSS variables and all mobile requirements.
2. **Sessions & identity:** SQLite, names, reserved names, claim codes, person folders, rate limits, admin login + claims + sessions + people screens.
3. **Deployment:** Docker Compose, Nginx + certbot config, SSH tunnel script + restricted tunnel user, model status (chat closes while the PC is unreachable), backups, README. Deploy and test on the real droplet early.
4. **Photo gates:** gate definitions + triggers, forced gates (single and global), consent checkbox, two-step upload, verification, storage + EXIF stripping, admin photo gallery with delete.
5. **SadGPT, leaderboard & points:** rebrand to SadGPT (name, logo from the tee design, copy), persona list with a global switch and per-session overrides, points ledger (gates + admin awards), leaderboard drawer, "first to N points" rewards with per-reward prize reveal.
6. **Curses + live events:** curse menu, effects, counter-curses, curse-break gates, SSE events with reconnect queue, in-page notifications. (The live event stream itself was built early, in Phase 3.)
7. **Secrets game:** see the section above.
8. **Hardening & testing:**
   - load-test script simulating ~30 concurrent guests
   - prompt-injection tests against gates and secrets
   - "pull the plug on the PC" test (chat closes and reopens, unverified gate path)
   - kill and restart the app container, verify data survives
   - mobile checks on iOS Safari and Android Chrome
9. **Skin pass:** final theme assets.

## Open questions

- IpsenGPT's character voice and backstory
- Gate targets and which triggers to use when
- What goes in each person's folder
- Secrets game: whether curses cost points (Phase 6)