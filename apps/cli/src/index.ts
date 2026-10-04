/**
 * The Hyphae CLI (ADR-013).
 *
 * Commands, minimal but real:
 *   hyphae up <root>       start watching a folder and syncing to the Hub
 *   hyphae checkpoint      ask the Hub to commit now (manual, ADR-006)
 *   hyphae status          show config
 *
 * The daemon is a thin wrapper: all sync logic lives in @hyphae/client, which
 * is unit-tested.
 */

import { parseArgs } from "node:util";
import { Watcher } from "@hyphae/client";

const USAGE = `hyphae <command> [options]

Commands:
  up <root>              Watch a folder and keep it in sync with the Hub
  checkpoint [repo]      Ask the Hub to commit the current state now
  status                 Show the resolved configuration

Options:
  --hub <url>            Hub base URL            (env HYPHAE_HUB)
  --repo <name>          Repo name               (env HYPHAE_REPO)
  --actor <id>           Actor id                (env HYPHAE_ACTOR)
  --help                 Show this help
`;

function resolveConfig(values: { hub?: string; repo?: string; actor?: string }) {
  return {
    hub: values.hub ?? process.env.HYPHAE_HUB ?? "http://localhost:8787",
    repo: values.repo ?? process.env.HYPHAE_REPO ?? "default",
    actor:
      values.actor ?? process.env.HYPHAE_ACTOR ?? `cli-${Math.random().toString(36).slice(2, 8)}`,
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      hub: { type: "string" },
      repo: { type: "string" },
      actor: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const command = positionals[0];
  const config = resolveConfig(values);

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (command === "checkpoint") {
    const repo = positionals[1] ?? config.repo;
    const res = await fetch(`${config.hub}/repos/${encodeURIComponent(repo)}/commit`, {
      method: "POST",
    });
    if (!res.ok) {
      process.stderr.write(`checkpoint failed: ${res.status} ${res.statusText}\n`);
      process.exitCode = 1;
      return;
    }
    let body: { committed?: boolean } = {};
    try {
      body = (await res.json()) as { committed?: boolean };
    } catch {
      process.stderr.write("checkpoint failed: invalid response from hub\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(body.committed ? "checkpoint committed\n" : "nothing to commit\n");
    return;
  }

  if (command === "up") {
    const root = positionals[1];
    if (!root) {
      process.stderr.write("error: up requires a folder\n");
      process.exitCode = 1;
      return;
    }
    const watcher = new Watcher({
      root,
      actorId: config.actor,
      hub: config.hub,
      repo: config.repo,
    });
    watcher.start();
    process.stdout.write(`watching ${root}, syncing to ${config.hub}/${config.repo}\n`);
    process.on("SIGINT", () => {
      watcher.stop();
      process.exit(0);
    });
    return;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
