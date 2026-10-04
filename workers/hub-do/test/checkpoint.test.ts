import { describe, expect, it } from "bun:test";
import { CheckpointScheduler } from "../src/checkpoint.ts";

describe("CheckpointScheduler", () => {
  it("is idle and not due before any change", () => {
    const s = new CheckpointScheduler({ quietMs: 30_000, ceilingMs: 300_000 });
    expect(s.hasPending).toBe(false);
    expect(s.due(0)).toBeNull();
    expect(s.nextCheckAt()).toBeNull();
  });

  it("is due after the quiet period", () => {
    const s = new CheckpointScheduler({ quietMs: 30_000, ceilingMs: 300_000 });
    s.onChange(1_000);
    expect(s.due(1_000 + 29_999)).toBeNull();
    expect(s.due(1_000 + 30_000)).toEqual({ reason: "quiet" });
  });

  it("extends the quiet window while changes keep arriving", () => {
    const s = new CheckpointScheduler({ quietMs: 30_000, ceilingMs: 300_000 });
    s.onChange(0);
    s.onChange(20_000); // a new change resets the quiet clock
    expect(s.due(40_000)).toBeNull(); // only 20s since the last change
    expect(s.due(50_000)).toEqual({ reason: "quiet" });
  });

  it("forces a checkpoint at the ceiling even while changes keep coming", () => {
    const s = new CheckpointScheduler({ quietMs: 30_000, ceilingMs: 300_000 });
    // A change every 20s never leaves a 30s quiet gap.
    for (let t = 0; t <= 300_000; t += 20_000) s.onChange(t);
    expect(s.due(300_000)).toEqual({ reason: "ceiling" });
  });

  it("returns to idle after a commit", () => {
    const s = new CheckpointScheduler({ quietMs: 1_000, ceilingMs: 60_000 });
    s.onChange(0);
    expect(s.due(1_000)).toEqual({ reason: "quiet" });
    s.onCommitted();
    expect(s.hasPending).toBe(false);
    expect(s.due(2_000)).toBeNull();
  });

  it("reports the next check time as the earlier of quiet and ceiling", () => {
    const s = new CheckpointScheduler({ quietMs: 30_000, ceilingMs: 300_000 });
    s.onChange(1_000);
    expect(s.nextCheckAt()).toBe(31_000);
    s.onChange(200_000);
    // ceiling is firstChangeAt + 300_000 = 301_000, quiet is 230_000
    expect(s.nextCheckAt()).toBe(230_000);
  });

  it("manual force only fires when there is something pending", () => {
    const s = new CheckpointScheduler();
    expect(s.force()).toBeNull();
    s.onChange(Date.now());
    expect(s.force()).toEqual({ reason: "manual" });
  });
});

describe("CheckpointScheduler: change during commit", () => {
  it("stays pending when a change lands mid-commit", () => {
    const s = new CheckpointScheduler({ quietMs: 30_000, ceilingMs: 300_000 });
    s.onChange(0);
    const gen = s.generation;
    expect(s.due(30_000)).toEqual({ reason: "quiet" });
    // A change arrives while the commit is in flight.
    s.onChange(30_050);
    s.onCommitted(gen);
    expect(s.hasPending).toBe(true);
    expect(s.due(60_100)).toEqual({ reason: "quiet" });
  });

  it("returns to idle when nothing changed during the commit", () => {
    const s = new CheckpointScheduler({ quietMs: 1_000, ceilingMs: 60_000 });
    s.onChange(0);
    const gen = s.generation;
    s.onCommitted(gen);
    expect(s.hasPending).toBe(false);
  });
});
