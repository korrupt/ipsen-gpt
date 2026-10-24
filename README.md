# IpsenGPT

Halloween costume chatbot. See [PLAN.md](PLAN.md) for the full spec.

```
apps/server   Express + TypeScript API (SSE chat streaming against Ollama)
apps/web      React + Vite frontend (ChatGPT lookalike, mobile-first)
content/      persona.md (the system prompt, never sent to the client)
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

## Theming

Every color, font, bubble style, background image and the portrait is a CSS custom property in
[apps/web/src/theme.css](apps/web/src/theme.css). To swap the portrait/logo, put the file in
`apps/web/public/` and change `--portrait-image`.
