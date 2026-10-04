/**
 * The Hyphae live view (ADR-013).
 *
 * A read-only participant: it connects to the Hub over the same WebSocket the
 * clients use, so it needs no special server or state. It renders connected
 * actors, the current files, a live activity feed, and a preview of the
 * selected file (fetched from R2 by hash).
 *
 * Plain JavaScript (no build step) so it is served directly as a static asset.
 */

const el = {
  repo: document.getElementById("repo"),
  connect: document.getElementById("connect"),
  dot: document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
  actors: document.getElementById("actors"),
  actorCount: document.getElementById("actorCount"),
  files: document.getElementById("files"),
  fileCount: document.getElementById("fileCount"),
  feed: document.getElementById("feed"),
  preview: document.getElementById("preview"),
  previewPath: document.getElementById("previewPath"),
};

const state = {
  repo: new URLSearchParams(location.search).get("repo") ?? "live-demo",
  socket: null,
  manifest: new Map(),
  actors: [],
  feed: [],
  selected: null,
};

const FEED_LIMIT = 200;

function baseUrl() {
  return `${location.protocol}//${location.host}`;
}

function wsUrl(repo) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const actorId = `view-${Math.random().toString(36).slice(2, 8)}`;
  return `${proto}//${location.host}/agents/hub/${encodeURIComponent(repo)}?actorId=${actorId}&displayName=live%20view&kind=human&observer=1`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderActors() {
  el.actorCount.textContent = String(state.actors.length);
  el.actors.innerHTML = "";
  if (state.actors.length === 0) {
    el.actors.innerHTML = '<li class="empty">no one connected</li>';
    return;
  }
  for (const a of state.actors) {
    const li = document.createElement("li");
    li.className = "actor";
    li.innerHTML = `<span class="actor-dot"></span><span>${escapeHtml(
      a.displayName,
    )}</span><span class="kind">${a.observer ? "view" : escapeHtml(a.kind)}</span>`;
    el.actors.appendChild(li);
  }
}

function renderFiles() {
  const paths = [...state.manifest.keys()].sort();
  el.fileCount.textContent = String(paths.length);
  el.files.innerHTML = "";
  if (paths.length === 0) {
    el.files.innerHTML = '<li class="empty">no files yet</li>';
    return;
  }
  for (const path of paths) {
    const entry = state.manifest.get(path);
    const li = document.createElement("li");
    if (path === state.selected) li.classList.add("active");
    li.innerHTML = `<span class="path">${escapeHtml(path)}</span><span class="kind">v${
      entry.version
    }</span>`;
    li.addEventListener("click", () => selectFile(path));
    el.files.appendChild(li);
  }
}

function renderFeed() {
  const events = state.feed.slice(-FEED_LIMIT);
  el.feed.innerHTML = "";
  if (events.length === 0) {
    el.feed.innerHTML = '<li class="empty">waiting for activity</li>';
    return;
  }
  for (const ev of events) {
    const li = document.createElement("li");
    li.className = ev.kind;
    const time = new Date(ev.at).toLocaleTimeString();
    const who = ev.by ? `by ${escapeHtml(ev.by)}` : "";
    const detail = ev.detail ? ` · ${escapeHtml(ev.detail)}` : "";
    li.innerHTML = `<span class="time">${time}</span><span class="path">${escapeHtml(
      ev.path ?? "",
    )}${detail}</span><span class="who">${who}</span>`;
    el.feed.appendChild(li);
  }
}

function addEvent(ev) {
  state.feed.push(ev);
  if (state.feed.length > FEED_LIMIT) state.feed = state.feed.slice(-FEED_LIMIT);
  renderFeed();
}

async function selectFile(path) {
  state.selected = path;
  renderFiles();
  const entry = state.manifest.get(path);
  el.previewPath.textContent = path;
  if (!entry) {
    el.preview.textContent = "no content";
    return;
  }
  el.preview.textContent = "loading...";
  try {
    const res = await fetch(`${baseUrl()}/blobs/${entry.blobHash}`);
    el.preview.textContent = res.ok ? await res.text() : "(could not load)";
  } catch {
    el.preview.textContent = "(could not load)";
  }
}

function setStatus(on, text) {
  el.dot.className = `dot ${on ? "on" : "off"}`;
  el.statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect(repo) {
  if (state.socket) state.socket.close();
  state.manifest.clear();
  state.actors = [];
  state.feed = [];
  renderActors();
  renderFiles();
  renderFeed();
  setStatus(false, "connecting...");

  const socket = new WebSocket(wsUrl(repo));
  state.socket = socket;

  socket.addEventListener("open", () => setStatus(true, `connected · ${repo}`));
  socket.addEventListener("close", () => setStatus(false, "disconnected"));
  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    handleMessage(msg);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case "manifest": {
      state.manifest = new Map(Object.entries(msg.entries || {}));
      renderFiles();
      break;
    }
    case "presence": {
      state.actors = msg.actors || [];
      renderActors();
      break;
    }
    case "history": {
      state.feed = msg.events || [];
      renderFeed();
      break;
    }
    case "changed": {
      const path = msg.path;
      if (msg.newHash === null) {
        state.manifest.delete(path);
        addEvent({ kind: "delete", path, by: msg.by, at: Date.now() });
      } else {
        state.manifest.set(path, {
          blobHash: msg.newHash,
          version: msg.version,
          updatedBy: msg.by,
          updatedAt: Date.now(),
        });
        addEvent({ kind: "change", path, by: msg.by, version: msg.version, at: Date.now() });
        if (state.selected === path) void selectFile(path);
      }
      renderFiles();
      break;
    }
    case "conflict": {
      addEvent({ kind: "conflict", path: msg.path, at: Date.now() });
      break;
    }
    case "resolved": {
      const path = msg.path;
      if (msg.newHash) {
        state.manifest.set(path, {
          blobHash: msg.newHash,
          version: (state.manifest.get(path)?.version ?? 0) + 1,
          updatedBy: "merging-agent",
          updatedAt: Date.now(),
        });
        renderFiles();
        if (state.selected === path) void selectFile(path);
      }
      addEvent({ kind: "resolved", path, by: "merging-agent", at: Date.now() });
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

el.repo.value = state.repo;
el.connect.addEventListener("click", () => {
  state.repo = el.repo.value.trim() || "live-demo";
  const url = new URL(location.href);
  url.searchParams.set("repo", state.repo);
  history.replaceState(null, "", url);
  connect(state.repo);
});
el.repo.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.connect.click();
});

connect(state.repo);
