/**
 * One-click scenarios that generate real protocol traffic, so the flagship
 * behaviours can be reproduced without timing two terminal clients by hand.
 *
 * The merge path keys off `baseHash`, not the actor, so a single connection
 * can stage both sides of a collision: write a base, then send two edits that
 * both claim the base version. Disjoint edits clean-merge; same-line edits
 * conflict and go to the merging agent.
 */

import type { HubApi } from "./hub";

export interface ScenarioResult {
  path: string;
  note: string;
}

const BASE = "line one\nline two\nline three\n";
const CLEAN_OURS = "OURS\nline two\nline three\n";
const CLEAN_THEIRS = "line one\nline two\nTHEIRS\n";
const CONFLICT_OURS = "line one\nOURS\nline three\n";
const CONFLICT_THEIRS = "line one\nTHEIRS\nline three\n";

async function stageBase(hub: HubApi, path: string): Promise<string> {
  await hub.sendChange(path, BASE);
  const hash = await hub.uploadBlob(BASE);
  const landed = await hub.waitForManifest(path, hash);
  if (!landed) throw new Error("base version did not reach the hub");
  return hash;
}

async function collide(hub: HubApi, path: string, ours: string, theirs: string): Promise<void> {
  const baseHash = await stageBase(hub, path);
  const oursHash = await hub.uploadBlob(ours);
  const theirsHash = await hub.uploadBlob(theirs);
  hub.sendRawChange(path, baseHash, oursHash);
  hub.sendRawChange(path, baseHash, theirsHash);
}

export async function runCleanMerge(hub: HubApi): Promise<ScenarioResult> {
  const path = "scenarios/clean-merge.txt";
  await collide(hub, path, CLEAN_OURS, CLEAN_THEIRS);
  return { path, note: "two disjoint edits, git should merge them cleanly" };
}

export async function runConflict(hub: HubApi): Promise<ScenarioResult> {
  const path = "scenarios/conflict.txt";
  await collide(hub, path, CONFLICT_OURS, CONFLICT_THEIRS);
  return { path, note: "same line changed twice, the agent takes over" };
}

export async function runBigFile(hub: HubApi): Promise<ScenarioResult> {
  const path = "scenarios/big-file.txt";
  const lines = Array.from(
    { length: 5000 },
    (_, i) => `line ${i + 1} of a large file, here to exercise transport and merging`,
  );
  await hub.sendChange(path, `${lines.join("\n")}\n`);
  return { path, note: "5000 lines through the blob path" };
}
