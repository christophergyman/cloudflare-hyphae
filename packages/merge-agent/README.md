# @hyphae/merge-agent

The verified merging agent (ADR-014): resolves conflicts git cannot, verifies
the result by running tests in a sandbox, and keeps both sides when unsure.

## Public API

Entry point: `src/index.ts`.

- `MergeAgent`, `defaultConflictMarkers`.
- `createMergeRunner`: builds the injected runner used by the Hub and Workflow.
- `createAiMergeModel`, `DEFAULT_MERGE_MODEL`, `buildMergePrompt`,
  `MERGE_SYSTEM_PROMPT`, `stripFences`, `extractText`.
- `detectTestCommand`: picks a test command from config or `package.json`.
- Types: `ConflictInput`, `MergeModel`, `MergeOutcome`, `SandboxVerifier`,
  `MergeJob`, `SandboxLike`, `AiBindingLike`.

`DEFAULT_MERGE_MODEL` is the single source of truth for the merge model. Keep
the `MODEL` values in both `cloudflare.config.ts` files in sync with it.

## Tests

```
bun test packages/merge-agent
```
