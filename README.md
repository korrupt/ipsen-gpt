# IpsenGPT

Halloween costume chatbot. See [PLAN.md](PLAN.md) for the full spec.

```
apps/server   Express + TypeScript API (SSE chat streaming against Ollama)
apps/web      React + Vite frontend: guest chat at /, admin dashboard at /admin/
content/      persona.md (the system prompt, never sent to the client)
              people.example/ (an example person folder)
data/         runtime state, gitignored: SQLite DB + people/ (volumes in production)
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
