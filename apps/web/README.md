# @hyphae/web

The Hyphae console: a live view of one repo's Hub and a full test client, so
the whole system can be exercised from the browser (ADR-013). Built with Vite,
React, Tailwind v4, and shadcn/ui (`radix-nova` style, monochrome theme).

## What it does

- Live presence, manifest, activity feed, and blob preview for one repo
- **One editor per tab**: an actor name you control, persisted locally, with
  `?actor=` overrides. Two tabs (or a tab and a CLI daemon) behave like two
  teammates. `?view=1` connects as a read-only observer
- **Invite links**: copies `?repo=...&actor=...` for a second teammate
- **Auto-connect**: `?repo=` deep links and the last used repo connect on load
- **Auto-reconnect**: backoff retries with a visible reconnecting state, last
  update time, and a manual Retry
- **Composer strip**: write, delete (tombstone), and one-click scenarios that
  generate real protocol traffic: clean merge, same-line conflict, big file
- **Conflict strip**: the agent lifecycle for each conflict (attempting, kept
  both, resolved) without reading the feed
- **Feed filters** (files, merges, conflicts, agent) and **line diffs** against
  the previous version seen while the tab was open
- Empty states include the exact CLI command to start a real client

## Dev

From the repo root, one command starts the Hub and this console:

```
bun run dev
```

Or run the pieces yourself, still with no Cloudflare account required:

```
cd workers/edge && bun run dev     # the Hub and API on 8787
cd apps/web && bun run dev         # the console on 5173
```

Vite proxies `/health`, `/repos`, `/blobs`, and `/agents` (WebSocket included)
to the Hub. Point at another Hub with
`HYPHAE_HUB_TARGET=https://<worker> bun run dev`.

## Build

```
bun run build
```

Output lands in `apps/web/dist`, which `workers/edge/wrangler.config.ts`
(`assetsDirectory`) serves as the Worker's static assets, so one `cf deploy`
ships the API and this console together.

## Theme

All colors are CSS variables in `src/index.css`. The palette is deliberately
monochrome for now; the `--signal-*` tokens (change, merge, conflict, resolved,
delete, error) differ by lightness only, and swapping in hues is a token edit.
Corners are near-zero radius (`--radius`) for a sharp, instrument-like feel.

## Legacy

The previous no-build live view lives in `public/` for reference. It is no
longer served now that the assets directory points at `dist/`.
