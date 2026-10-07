#!/usr/bin/env bun
/**
 * One-command dev stack (see the root README).
 *
 * Starts what is missing and reuses what already answers:
 *   - the Hub: the edge Worker via `cf dev` on 8787
 *   - the console: Vite on 5173
 *   - with `--demo`: a CLI client watching ./demo (seeded on first run)
 *
 * Ctrl+C stops only the processes this script started.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const hubPort = Number(process.env.HYPHAE_HUB_PORT ?? 8787);
const webPort = Number(process.env.HYPHAE_WEB_PORT ?? 5173);
const withDemo = process.argv.includes("--demo");

const hubUrl = `http://127.0.0.1:${hubPort}`;
const webUrl = `http://localhost:${webPort}`;

interface Child {
  label: string;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
}

const children: Child[] = [];

function log(message: string): void {
  process.stdout.write(`[dev] ${message}\n`);
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Forward a child's output with a stable prefix, line by line. */
async function prefixStream(
  label: string,
  stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${label} ${line}\n`);
  }
  if (buffer.length > 0) process.stdout.write(`${label} ${buffer}\n`);
}

function spawn(label: string, cmd: string[], cwd: string, env: Record<string, string> = {}): Child {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  void prefixStream(label, proc.stdout);
  void prefixStream(label, proc.stderr);
  void proc.exited.then((code) => {
    if (!stopping) log(`${label} exited with code ${code}`);
  });
  const child: Child = { label, proc };
  children.push(child);
  return child;
}

async function waitFor(url: string, label: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isUp(url)) return;
    await Bun.sleep(400);
  }
  throw new Error(`${label} did not come up within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Seed the demo folder. Missing files are written; existing ones are touched,
 * so every `dev:demo` run syncs their current content (the client has no
 * initial scan, so the watcher needs an event).
 */
function seedDemo(): number {
  const demoDir = join(root, "demo");
  mkdirSync(demoDir, { recursive: true });
  const files: Array<[string, string]> = [
    [
      "welcome.md",
      "# Welcome to Hyphae\n\nThis folder is watched by a real CLI client.\nEdit a file and watch the console update live.\n",
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the seed file intentionally contains a template literal
    ["hello.ts", "export function hello(name: string): string {\n  return `hello, ${name}`;\n}\n"],
  ];
  let touched = 0;
  for (const [name, content] of files) {
    const path = join(demoDir, name);
    if (!existsSync(path)) {
      writeFileSync(path, content);
    } else {
      utimesSync(path, new Date(), new Date());
    }
    touched += 1;
  }
  return touched;
}

let stopping = false;
function shutdown(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.proc.kill();
    } catch {
      // The child already exited.
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

log(`dev stack in ${root}`);

if (await isUp(`${hubUrl}/health`)) {
  log(`hub already up on ${hubUrl}, reusing it`);
} else {
  log(`starting hub on ${hubUrl} (first boot takes a few seconds)`);
  spawn("[hub]", ["bun", "run", "dev"], join(root, "workers", "edge"), {
    HYPHAE_HUB_PORT: String(hubPort),
  });
}

if (await isUp(webUrl)) {
  log(`console already up on ${webUrl}, reusing it`);
} else {
  log(`starting console on ${webUrl}`);
  spawn(
    "[web]",
    ["bun", "run", "dev", "--port", String(webPort), "--strictPort"],
    join(root, "apps", "web"),
    { HYPHAE_HUB_TARGET: hubUrl },
  );
}

try {
  await waitFor(`${hubUrl}/health`, "hub", 40_000);
  await waitFor(webUrl, "console", 40_000);
} catch (err) {
  process.stderr.write(`[dev] ${err instanceof Error ? err.message : String(err)}\n`);
  shutdown(1);
}

if (withDemo) {
  // The watcher needs the folder to exist before it starts.
  mkdirSync(join(root, "demo"), { recursive: true });
  log('starting demo client watching ./demo (repo "demo", actor "demo-client")');
  spawn(
    "[client]",
    [
      "bun",
      "run",
      "apps/cli/src/index.ts",
      "up",
      join(root, "demo"),
      "--hub",
      hubUrl,
      "--repo",
      "demo",
      "--actor",
      "demo-client",
    ],
    root,
  );
  // Seed after the client starts: the writes and touches are ordinary file
  // events and sync like any other edit.
  await Bun.sleep(1500);
  log(`seeded ./demo (${seedDemo()} files)`);
}

process.stdout.write(
  [
    "",
    "[dev] --------------------------------------------",
    `[dev] console  ${webUrl}`,
    `[dev] hub      ${hubUrl}  (health ok)`,
    withDemo
      ? '[dev] client   ./demo -> repo "demo"'
      : '[dev] client   run "bun run dev:demo" to add one',
    "[dev] try      Write in the composer, then Clean merge / Conflict",
    "[dev] stop     Ctrl+C",
    "[dev] --------------------------------------------",
    "",
  ].join("\n"),
);

if (children.length === 0) {
  log("all services already running, nothing to supervise");
  process.exit(0);
}

// Stay alive; Ctrl+C stops the children, and the script ends when they do.
await Promise.all(children.map((child) => child.proc.exited));
shutdown(0);
