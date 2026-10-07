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
- **Node.js 22.18 or later** for the `cf` CLI, which loads
  `cloudflare.config.ts`. `cf` and Wrangler are dev dependencies, so
  `bunx cf` works after install.

## 1. Install dependencies

From the repo root:

```
bun install
```

## 2. Log in to Cloudflare

```
bunx cf auth login
```

This opens a browser and stores an OAuth token for `cf`. Verify with
`bunx cf auth whoami`.

## 3. Create the R2 bucket

Blob content is content-addressed and lives in R2. The binding is `BLOBS` and
the default bucket name is `hyphae-blobs`:

```
bunx cf r2 buckets create-by-name hyphae-blobs
```

If you pick a different name, update the `BLOBS` binding in the next step to match.

## 4. Configure the edge Worker

Open `workers/edge/cloudflare.config.ts` and check two things:

- **`BLOBS`** must match the bucket you created
  (`bindings.r2({ name: "hyphae-blobs" })`).
- **`compatibilityDate`** should be recent. It currently reads `2026-10-01`;
  bump it to today or a date you are happy pinning. Do not set it in the future.

The other bindings work as-is:

| Binding | Resource | Purpose |
|---|---|---|
| `BLOBS` | R2 bucket | Content-addressed file bytes |
| `ARTIFACTS` | Artifacts namespace `default` | Durable git history |
| `AI` | Workers AI | Model calls for the merge agent |
| `Hub` | Durable Object | One Hub per repo |
| `ASSETS` | Static assets (`apps/web/public`) | The live view |
| `MODEL` | Var (optional) | Overrides the merge model; default is `DEFAULT_MERGE_MODEL` in `packages/merge-agent/src/model.ts` |
| `AI_GATEWAY_ID` | Var (optional) | Routes merge model calls through AI Gateway (ADR-021) |

`compatibility_flags = ["nodejs_compat"]` is required and already set.

## 5. Deploy the edge Worker and the Hub

One deploy covers both the edge and the Durable Object. The Hub class is
re-exported at `workers/edge/src/index.ts:125`:

```ts
export { Hub } from "@hyphae/hub";
```

The bundler sees that re-export and bundles the Hub into the same Worker, so the
`Hub` binding and `exports.Hub` entry in `cloudflare.config.ts` resolve without
a second deploy.

```
cd workers/edge
bunx cf deploy
```

The first deploy creates the SQLite-backed `Hub` class from the `exports.Hub`
entry.
`cf` prints the deployed URL, for example
`https://hyphae-edge.<your-subdomain>.workers.dev`. Use that URL below.

## 6. Optional: deploy the merge Workflow

The verified merge Workflow is a real Worker: a `WorkflowEntrypoint` plus a
container-backed Sandbox Durable Object. It is **optional** for the demo (the Hub
still resolves conflicts inline), but deploying it gives you the durable,
test-verified merge path from ADR-014.

```
cd workers/merge-workflow
bunx cf deploy
```

The deployment entry is `src/worker.ts`. It exports:

- `MergeWorkflow` (`src/workflow.ts`), bound as `MERGE_WORKFLOW` through
  `[[workflows]]`. Its `run` calls `runConflictJob` inside a single `step.do`,
  so a merge is persisted and retried durably.
- `Sandbox`, a Durable Object bound as `SANDBOX` through `[[containers]]` with
  `scheduling_policy = "durable_object"`. The verifier writes the candidate
  tree into the container and runs the project's test command there.

It uses the same default merge model as the Hub (`DEFAULT_MERGE_MODEL` in
`packages/merge-agent/src/model.ts`) unless `MODEL` is set to override it.

### Trigger and check a merge

`POST /merge` takes a `ConflictJob` JSON body and returns the instance id with
`202`:

```
export WORKFLOW_URL=https://hyphae-merge-workflow.<your-subdomain>.workers.dev
curl -s -X POST $WORKFLOW_URL/merge \
  -H 'content-type: application/json' \
  -d '{"repoId":"demo","path":"src/app.ts","base":"a\nb\nc\n","ours":"a\nOURS\nc\n","theirs":"a\nTHEIRS\nc\n"}'
# {"id":"<instance-id>"}
```

`GET /merge/:id` returns the Workflow instance status (including the
`MergeWorkflowResult` in `output` once complete):

```
curl -s $WORKFLOW_URL/merge/<instance-id>
```

`GET /health` returns `{"ok":true}`.

### Container

The container is wired with the Cloudflare-managed `cloudflare/debian-trixie`
image and the `durable-object` scheduling policy, so no image build is needed
and `cf deploy --dry-run` passes without Docker. The Sandbox DO starts the
image on first use and runs the project's tests with outbound Internet enabled
so dependencies can install. That wiring is the `defineContainer` entry in
`workers/merge-workflow/cloudflare.config.ts`, attached to the `Sandbox`
export.

To bake git and a pinned Node into the image instead, add the repo Dockerfile as
a named image in the same `defineContainer` (this requires Docker on the machine
that runs `cf deploy`):

```ts
const sandbox = defineContainer({
  name: "hyphae-sandbox",
  schedulingPolicy: "durable-object",
  images: {
    sandbox: { dockerfile: "../../infra/container/Dockerfile" },
  },
});
```

Then start `ctx.container.images.sandbox` in `Sandbox` instead of the managed
image string. Before running untrusted repos, add an egress intercept
(`interceptAllOutboundHttp`) or pre-bake dependencies, per ADR-014.

## 7. AI Gateway and secrets

The edge and Workflow Workers bind Workers AI directly through the `[ai]`
binding named `AI`. To route model calls through **AI Gateway** (caching, rate
limits, fallback, provider keys):

1. Create a gateway in the Cloudflare dashboard under AI Gateway.
2. Add `AI_GATEWAY_ID: bindings.text("<gateway-id>")` to the `env` in
   `workers/edge/cloudflare.config.ts` (and
   `workers/merge-workflow/cloudflare.config.ts`). The Hub passes it to the merge model,
   which routes the call through the gateway (ADR-021). Leave it unset to call
   Workers AI directly. See `docs/hyphae-stack.md` for the intended wiring.
3. For an external provider, keep the provider key out of source. Store it with
   Secrets Store or:

```
bunx wrangler secret put <NAME> --name hyphae-edge   # cf cannot set a single secret yet
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
  the binding in `cloudflare.config.ts`.
- **413 on `/blobs`:** the body exceeded the 1.5 MB inline cap. Presigned R2
  URLs are designed but not implemented (`/blobs/presign` returns 501).
- **Model override:** `MODEL` is optional. When set in `cloudflare.config.ts` it
  must be a valid Workers AI model. The default is `DEFAULT_MERGE_MODEL` in
  `packages/merge-agent/src/model.ts`.
