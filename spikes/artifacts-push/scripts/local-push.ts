/**
 * Spike 1, local harness.
 *
 * Proves that isomorphic-git can commit and push over smart HTTP inside a
 * Node/Bun runtime, against a real git HTTP server. This is the same code path
 * the Worker uses, minus Cloudflare's Artifacts host and token auth.
 *
 * Run: bun run local
 */

import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import pkg from "node-git-server";

const { Git: GitServer } = pkg as { Git: new (root: string, opts?: unknown) => GitServerLike };

interface GitServerLike {
  on(
    event: "push" | "fetch",
    cb: (ctx: { accept(): void; reject(msg?: string): void }) => void,
  ): void;
  listen(port: number, options: { type: "http" }, cb: (err?: Error) => void): void;
  close(): Promise<unknown>;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hyphae-spike-"));
  const workDir = join(root, "work");
  await mkdir(workDir, { recursive: true });
  console.log("step: tmp ready");

  const port = 7100 + Math.floor(Math.random() * 2000);
  const server = new GitServer(root, { autoCreate: true });
  server.on("push", (push) => push.accept());
  server.on("fetch", (fetch) => fetch.accept());
  await new Promise<void>((resolve, reject) => {
    server.listen(port, { type: "http" }, (err) => (err ? reject(err) : resolve()));
  });
  const remote = `http://localhost:${port}/demo.git`;
  console.log(`step: server listening at ${remote}`);

  // isomorphic-git: init, write, add, commit, push over HTTP.
  await git.init({ fs, dir: workDir, defaultBranch: "main" });
  await writeFile(join(workDir, "README.md"), "# pushed over HTTP by isomorphic-git\n");
  await git.add({ fs, dir: workDir, filepath: "README.md" });
  const first = await git.commit({
    fs,
    dir: workDir,
    message: "initial commit",
    author: { name: "cman", email: "cman@example.com" },
  });
  await git.addRemote({ fs, dir: workDir, remote: "origin", url: remote });
  await git.push({ fs, dir: workDir, remote: "origin", ref: "main", http });
  console.log("step: first push done");

  // An incremental commit, like a checkpoint (ADR-006).
  await writeFile(join(workDir, "src.txt"), "export const x = 1;\n");
  await git.add({ fs, dir: workDir, filepath: "src.txt" });
  const second = await git.commit({
    fs,
    dir: workDir,
    message: "incremental checkpoint",
    author: { name: "cman", email: "cman@example.com" },
  });
  await git.push({ fs, dir: workDir, remote: "origin", ref: "main", http });
  console.log("step: second push done");

  // Verify by cloning with isomorphic-git (async, so the in-process server
  // keeps serving). A synchronous git CLI clone here would deadlock the loop.
  const cloneDir = join(root, "clone");
  await git.clone({ fs, dir: cloneDir, url: remote, http, singleBranch: true });
  const logEntries = await git.log({ fs, dir: cloneDir, ref: "main" });
  const files = await git.listFiles({ fs, dir: cloneDir, ref: "main" });
  console.log("step: clone done");

  console.log(`\nfirst commit:  ${first}`);
  console.log(`second commit: ${second}`);
  console.log("\ncloned log:");
  for (const entry of logEntries) {
    console.log(`  ${entry.oid.slice(0, 7)} ${entry.commit.message.trim()}`);
  }
  console.log(`\ncloned files: ${files.sort().join(", ")}`);
  console.log("\nRESULT: isomorphic-git commit + push over smart HTTP works.");
  console.log("Mechanics validated. Only the Artifacts host + token auth remain.");

  await server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
