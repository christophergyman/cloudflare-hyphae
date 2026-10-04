# @hyphae/cli

The Hyphae command line (ADR-013): a thin wrapper that watches a folder and
syncs it to a Hub, with a manual checkpoint and a status command.

## Entry points

Entry point: `src/index.ts`, exposed as the `hyphae` bin.

- `hyphae up <root>`: watch a folder and keep it in sync. Options `--hub`,
  `--repo`, `--actor` (or `HYPHAE_HUB`, `HYPHAE_REPO`, `HYPHAE_ACTOR`).
- `hyphae checkpoint [repo]`: ask the Hub to commit now (ADR-006).
- `hyphae status`: print the resolved configuration.

All sync logic lives in `@hyphae/client`, which is unit-tested. Run it with:

```
bun run apps/cli/src/index.ts --help
```

## Tests

There is no CLI test suite yet; its logic is covered by `apps/client`:

```
bun test apps/client
```
