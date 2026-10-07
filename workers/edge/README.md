# @hyphae/edge

The edge Worker: auth, routing, REST, WebSocket upgrade, blob transport, and
the static live view (ADR-002, ADR-012, ADR-020).

## Entry points

Entry point: `src/index.ts`.

- Default export: the `fetch` handler serving `/health`, `/repos/*`, `/blobs*`,
  and `/agents/*`, then falling through to the live view assets.
- `Env`: the Worker bindings (`BLOBS`, `Hub`, `ARTIFACTS`, `AI`, `ASSETS`,
  `MODEL`, `ENVIRONMENT`).
- Re-exports `Hub` from `@hyphae/hub` so the Durable Object class ships in the
  same Worker. One `cf deploy` covers the edge and the Hub.

## Deploy and tests

```
cd workers/edge && bunx cf deploy
bun test workers/edge
```

## Local dev

```
bun run dev          # this package, from workers/edge
```

From the repo root, `bun run dev` starts this Worker and the console together
(see `scripts/dev.ts`). The underlying command is `cf dev` on port 8787;
arguments after `--` are forwarded to the dev server. Serves the API, the Hub
Durable Object, and the built console assets (`apps/web/dist`, set by
`wrangler.config.ts`). Build the console first with
`bun run --cwd apps/web build`.

See `docs/deploy-your-own.md` for the full path.
