# Hyphae live view

A read-only dashboard that watches a repo in real time: connected actors, the
current files, a live activity feed, and a preview of the selected file.

It is served by the edge Worker via Static Assets, so the UI and the API share
one origin and one deploy.

## What it shows

- **Connected:** who is in the room (humans, agents, and other viewers).
- **Files:** current files and their versions, from the Hub manifest.
- **Activity:** a live feed of changes, clean merges, conflicts, and agent
  resolutions. The Hub keeps the last 200 events, so the feed is populated the
  moment you open or refresh.
- **Preview:** the current content of the file you select, fetched from R2.

## How it works

The view connects to the Hub as an observer (`observer=1`) over the same
WebSocket the clients use. It listens for `manifest`, `presence`, `history`,
`changed`, `conflict`, and `resolved`, and fetches blob content over HTTP. It
holds no state of its own and never edits anything.

## Run it

Served automatically by the edge Worker:

```
cd workers/edge
bunx cf deploy
```

Then open the Worker URL and enter a repo name (or use `?repo=name`).

To run the UI locally against the deployed Hub, serve `apps/web/public` with any
static server and open it; it targets the same origin by default, so for local
dev point it at the deployed origin by hosting the files there.
