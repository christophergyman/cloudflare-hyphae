# @hyphae/protocol

The versioned Hyphae wire protocol (ADR Part 4): the zod schemas and types for
every message between clients and the Hub, plus the Hub RPC contract.

## Public API

Entry point: `src/index.ts`.

- `PROTOCOL_VERSION`.
- Client to Hub schemas: `helloMessageSchema`, `changeMessageSchema`,
  `ackMessageSchema`, `clientMessageSchema`.
- Hub to client schemas: `manifestMessageSchema`, `changedMessageSchema`,
  `conflictMessageSchema`, `resolvedMessageSchema`, `presenceMessageSchema`,
  `errorMessageSchema`, `historyMessageSchema`, `hubMessageSchema`.
- REST schemas: `presignRequestSchema`, `presignResponseSchema`,
  `createRepoSchema`, `repoResponseSchema`.
- Helpers and contract: `parseClientMessage`, `parseHubMessage`,
  `safeParseHubMessage`, `HubRpc`, and the inferred message types.

## Tests

```
bun test packages/protocol
```
