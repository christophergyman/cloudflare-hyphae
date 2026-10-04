# @hyphae/merge-workflow

The verified merge Workflow wiring (ADR-014): on a true conflict it asks a
code-capable model to resolve it and accepts the result only if the project's
tests pass in a sandbox.

## Public API

Entry point: `src/index.ts` (a re-export barrel over `src/runner.ts`).

- `makeMergeRunner(env)`: builds the shared runner from the runtime bindings.
- `runConflictJob(env, job)`: runs one conflict end to end and maps the result.
- Types: `MergeWorkflowEnv`, `ConflictJob`, `MergeWorkflowResult`, and the
  re-exported `AiBindingLike` / `SandboxLike`.
- Re-exports `buildMergePrompt`, `MERGE_SYSTEM_PROMPT`, `stripFences`.

All decision logic lives in `@hyphae/merge-agent`, so the Hub's inline path and
this Workflow cannot diverge. The `MODEL` var stays in sync with
`DEFAULT_MERGE_MODEL` in `packages/merge-agent/src/model.ts`.

## Tests

```
bun test workers/merge-workflow
```
