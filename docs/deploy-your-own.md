# Deploy your own

Run the full Hyphae demo on your own Cloudflare account: the edge API, the
per-repo Hub (a Durable Object), R2 blob storage, and durable git history on
Artifacts. The live view ships in the same deploy.

This guide assumes a **fresh Cloudflare account** and no existing resources.

## Prerequisites

- **Bun** (the client runtime and the test runner). Install from https://bun.sh.
- **A Cloudflare account on the Workers Paid plan** (about $5/mo). Artifacts,
  Containers, Workflows, and the good Workers AI code models all require it.
- **Artifacts open beta access.** Artifacts is in open beta and available on the
  Workers Paid plan. If the `[[artifacts]]` binding is rejected at deploy time,
  your account does not have access yet.
- **Wrangler** is a dev dependency, so `bunx wrangler` works after install.

## 1. Install dependencies

From the repo root:

```
bun install
```

## 2. Log in to Cloudflare

```
bunx wrangler login
```

This opens a browser and stores an OAuth token locally. Verify with
`bunx wrangler whoami`.

## 3. Create the R2 bucket

Blob content is content-addressed and lives in R2. The binding is `BLOBS` and
the default bucket name is `hyphae-blobs`:

```
bunx wrangler r2 bucket create hyphae-blobs
```

If you pick a different name, update `bucket_name` in the next step to match.

## 4. Configure the edge Worker

Open `workers/edge/wrangler.toml` and check two things:

- **`bucket_name`** under `[[r2_buckets]]` must match the bucket you created
  (default `hyphae-blobs`).
- **`compatibility_date`** should be recent. It currently reads `2026-10-01`;
  bump it to today or a date you are happy pinning. Do not set it in the future.

The other bindings work as-is:

| Binding | Resource | Purpose |
|---|---|---|
| `BLOBS` | R2 bucket | Content-addressed file bytes |
| `ARTIFACTS` | Artifacts namespace `default` | Durable git history |
| `AI` | Workers AI | Model calls for the merge agent |
| `Hub` | Durable Object | One Hub per repo |
| `ASSETS` | Static assets (`apps/web/public`) | The live view |
| `MODEL` | Var | Merge model; default matches `packages/merge-agent/src/model.ts` |

`compatibility_flags = ["nodejs_compat"]` is required and already set.

## 5. Deploy the edge Worker and the Hub

One deploy covers both the edge and the Durable Object. The Hub class is
re-exported at `workers/edge/src/index.ts:125`:

```ts
export { Hub } from "@hyphae/hub";
```

Wrangler sees that re-export and bundles the Hub into the same Worker, so the
`[[durable_objects.bindings]]` and `[[migrations]]` entries in the toml resolve
without a second deploy.

```
cd workers/edge
bunx wrangler deploy
```

The first deploy runs migration `v1` and creates the SQLite-backed `Hub` class.
Wrangler prints the deployed URL, for example
`https://hyphae-edge.<your-subdomain>.workers.dev`. Use that URL below.

## 6. Optional: deploy the merge Workflow

The verified merge Workflow is **optional** for the demo. It currently ships as
wiring (`makeMergeRunner`, `runConflictJob` in `workers/merge-workflow/src`) and
the `[[containers]]` binding is commented out in its `wrangler.toml`. Without a
Sandbox/container binding the merge agent refuses to accept unverified model
output and keeps both sides, which is the safe default.

If you want the Workflow deployed as its own Worker:

```
cd workers/merge-workflow
bunx wrangler deploy
```

It reads the same `MODEL` default (kept in sync with
`packages/merge-agent/src/model.ts`). To make it actually verify merges, add a
container binding and a Workflow entrypoint; see `docs/hyphae-adr.md` ADR-014.

## 7. AI Gateway and secrets

The edge and Workflow Workers bind Workers AI directly through the `[ai]`
binding named `AI`. To route model calls through **AI Gateway** (caching, rate
limits, fallback, provider keys):

1. Create a gateway in the Cloudflare dashboard under AI Gateway.
2. Point the `AI` binding at the gateway, or configure the gateway upstream of
   Workers AI. See `docs/hyphae-stack.md` for the intended wiring.
3. For an external provider, keep the provider key out of source. Store it with
   Secrets Store or:

```
cd workers/edge
bunx wrangler secret put <NAME>
```

No secret is required for the Workers AI default path.

## 8. Smoke test

Replace `$URL` with your deployed Worker URL.

Health:

```
export URL=https://hyphae-edge.<your-subdomain>.workers.dev
curl -s $URL/health
# {"ok":true,"service":"hyphae-edge","version":"0.0.0"}
```

Blob round-trip (`PUT /blobs` then `GET /blobs/:hash`):

```
HASH=$(curl -s -X PUT $URL/blobs --data-binary 'hello' | sed -E 's/.*"hash":"([a-f0-9]+)".*/\1/')
echo "$HASH"
curl -s $URL/blobs/$HASH
# hello
```

Force a checkpoint (`POST /repos/:name/commit`), which commits the Hub manifest
to Artifacts:

```
curl -s -X POST $URL/repos/demo/commit
# {"committed":true}
```

`committed` is `true` when every manifest file was read and committed. An empty
repo or a missing Artifacts binding returns `{"committed":false}`.

## 9. Open the live view

Visit the Worker URL in a browser and enter a repo name (or use
`?repo=demo`). The dashboard shows connected actors, current files, the activity
feed, and a file preview. It is a read-only observer over the same WebSocket.

To drive real changes, point the CLI at the Hub:

```
bun run apps/cli/src/index.ts up ./some-folder --hub $URL --repo demo
```

See `apps/cli/README.md` and `apps/client/README.md` for the watcher details.

## Troubleshooting

- **Artifacts binding rejected:** the account lacks open beta access. This is a
  prerequisite, not a config error.
- **`committed:false`:** either nothing changed or `ARTIFACTS` is missing. Check
  the binding in `wrangler.toml`.
- **413 on `/blobs`:** the body exceeded the 1.5 MB inline cap. Presigned R2
  URLs are designed but not implemented (`/blobs/presign` returns 501).
- **Model mismatch:** `MODEL` in both `wrangler.toml` files must equal
  `DEFAULT_MERGE_MODEL` in `packages/merge-agent/src/model.ts`.
