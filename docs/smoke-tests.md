# Smoke tests

Live and local results for Hyphae. Run these to verify the system end to end.

Deployed Worker: `https://hyphae-edge.christophergayiuman.workers.dev`
Repo: `cloudflare-hyphae`

## Live on Cloudflare (verified)

These exercise the real bindings: Agents SDK WebSocket, Durable Objects, R2, and the live 3-way merge.

| Test | Result |
|---|---|
| `GET /health` | 200 `{ok:true}` |
| Blob PUT then GET (`/blobs`) | R2 round-trip works |
| Two WS clients connect to the Hub | connect, get `manifest`, `presence` |
| A sends a change, B receives `changed` | live broadcast works |
| Concurrent **disjoint** edits to one file | Hub clean-merges, correct content (`ALPHA\nbeta\nGAMMA\n`) |
| Concurrent **same-line** edits | Hub surfaces `conflict` |
| `POST /repos/:name/commit` | 200, `{"committed":false}` (no durable store bound yet) |
| Durable Object execution in `wrangler tail` | healthy, ~8ms CPU, no errors |

Reproduce the live checks:

```
export URL=https://hyphae-edge.christophergayiuman.workers.dev
curl -s $URL/health
HASH=$(curl -s -X PUT $URL/blobs --data-binary 'hello' | grep -oE '"hash":"[a-f0-9]+"' | cut -d'"' -f4)
curl -s $URL/blobs/$HASH
```

The WebSocket and merge checks live in the session scripts and are summarized above.

## Local, real data (verified)

These run with no Cloudflare account, using a real git HTTP server and the real Hub logic.

| Test | Result |
|---|---|
| Artifacts adapter, 201 files | commit + clone-back in ~500ms |
| Artifacts adapter, second checkpoint (edits, deletes, adds) | 205 files correct |
| 200 sequential edits through `HubCore` | no line loss |
| 5000 randomized disjoint merges | 0 failures, 0 false conflicts |
| 2000 deliberate same-line conflicts | 0 missed |
| 2000 randomized merges vs `git merge-file` | 0 mismatches |

## Bug found by smoke testing

A 5000-line file could not merge: `mergeFile` had a `MAX_LINES = 4000` cap that
turned any larger file into a whole-file conflict, silently escalating trivially
disjoint edits to the AI. The LCS-table diff was replaced with a Myers O(ND)
diff (memory bounded by edit distance, not n*m) and the cap raised to a
pathological-input guard. Large files now merge cleanly (5000 lines in ~3ms),
and a regression test covers it.

## Not yet exercised live

- **Artifacts binding** as the Hub's `REPO_STORE` (the adapter is verified
  against a real git server locally; the live binding needs wiring in the
  deployed Worker).
- **AI Gateway + Contrast** merge (needs the model and container bindings
  configured on the deployed Worker).
- **Checkpoints** on the live Hub (same: needs `REPO_STORE` bound).
