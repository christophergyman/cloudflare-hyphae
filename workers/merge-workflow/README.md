# @hyphae/merge-workflow

The verified merge Workflow (ADR-014): on a true conflict it asks a
code-capable model to resolve it and accepts the result only if the project's
tests pass in a sandbox.

## Public API

Runtime-agnostic (Bun-testable) entry point: `src/index.ts`, a re-export barrel
over `src/runner.ts`.

- `makeMergeRunner(env)`: builds the shared runner from the runtime bindings.
- `runConflictJob(env, job)`: runs one conflict end to end and maps the result.
- Types: `MergeWorkflowEnv`, `ConflictJob`, `MergeWorkflowResult`, and the
  re-exported `AiBindingLike` / `SandboxLike`.
- Re-exports `buildMergePrompt`, `MERGE_SYSTEM_PROMPT`, `stripFences`.

All decision logic lives in `@hyphae/merge-agent`, so the Hub's inline path and
this Workflow cannot diverge. The `MODEL` var stays in sync with
`DEFAULT_MERGE_MODEL` in `packages/merge-agent/src/model.ts`.

## Deployment

`cloudflare.config.ts` points `entrypoint` at `src/worker.ts`, which is the only
workerd entry:

- `src/workflow.ts`: `MergeWorkflow extends WorkflowEntrypoint`. Its `run` calls
  `runConflictJob` inside `step.do("merge", ...)`. Declared with
  `exports.workflow` and bound as `MERGE_WORKFLOW`.
- `src/worker.ts`: default `fetch` handler and the `Sandbox` Durable Object.
  `Sandbox` uses `ctx.container` with the DO-managed scheduling policy and
  starts the Cloudflare-managed `cloudflare/debian-trixie` image, so no image
  build is needed. The container application is the `defineContainer` entry,
  attached to the `Sandbox` export. `SANDBOX` is a raw
  `durable_object_namespace` binding because cf beta rejects a `script_name`
  on the class a container is attached to; see the comment in the config.

Routes:

| Method | Path | Result |
|---|---|---|
| `POST` | `/merge` | Starts a job from a `ConflictJob` body, returns `{ id }` (202) |
| `GET` | `/merge/:id` | Returns the Workflow instance status |
| `GET` | `/health` | Returns `{ ok: true }` |

Deploy from this directory:

```
bunx cf deploy
```

To bake git and a pinned Node into the sandbox image instead of using the
managed image, add it under `images` in the `defineContainer` entry and start
`ctx.container.images.sandbox` in `Sandbox`. That path requires Docker at deploy
time.

## Tests

```
bun test workers/merge-workflow
```
