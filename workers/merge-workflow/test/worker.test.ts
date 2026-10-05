import { beforeAll, describe, expect, it, mock } from "bun:test";

/**
 * The deployment entry imports workerd-only APIs, so stub them before the
 * dynamic import. The routing under test is plain fetch/Response code.
 */
mock.module("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
  DurableObject: class {},
}));

interface FakeWorkflow {
  create(options: { params: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}

let fetchHandler: (request: Request, env: unknown) => Promise<Response>;

beforeAll(async () => {
  const mod = await import("../src/worker.ts");
  fetchHandler = mod.default.fetch as unknown as (
    request: Request,
    env: unknown,
  ) => Promise<Response>;
});

function fakeEnv(workflow: Partial<FakeWorkflow> = {}): {
  env: unknown;
  created: unknown[];
} {
  const created: unknown[] = [];
  const env = {
    MERGE_WORKFLOW: {
      async create(options: { params: unknown }) {
        created.push(options.params);
        return { id: "merge-1" };
      },
      async get(id: string) {
        return {
          async status() {
            return { status: "complete", output: { id } };
          },
        };
      },
      ...workflow,
    },
  };
  return { env, created };
}

const job = {
  repoId: "r",
  path: "src/app.ts",
  base: "a",
  ours: "b",
  theirs: "c",
};

describe("merge worker routing", () => {
  it("reports health", async () => {
    const res = await fetchHandler(new Request("https://w/health"), fakeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
  });

  it("starts a merge job and returns its id with 202", async () => {
    const { env, created } = fakeEnv();
    const res = await fetchHandler(
      new Request("https://w/merge", { method: "POST", body: JSON.stringify(job) }),
      env,
    );
    expect(res.status).toBe(202);
    expect(await res.json<{ id: string }>()).toEqual({ id: "merge-1" });
    expect(created).toEqual([job]);
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await fetchHandler(
      new Request("https://w/merge", { method: "POST", body: "not json" }),
      fakeEnv().env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body missing ConflictJob fields with 400", async () => {
    const res = await fetchHandler(
      new Request("https://w/merge", { method: "POST", body: JSON.stringify({ repoId: "r" }) }),
      fakeEnv().env,
    );
    expect(res.status).toBe(400);
  });

  it("returns the status of a started job", async () => {
    const res = await fetchHandler(new Request("https://w/merge/merge-1"), fakeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json<{ status: string; output: { id: string } }>()).toEqual({
      status: "complete",
      output: { id: "merge-1" },
    });
  });

  it("returns 404 for an unknown job id", async () => {
    const { env } = fakeEnv({
      async get() {
        throw new Error("nope");
      },
    });
    const res = await fetchHandler(new Request("https://w/merge/missing"), env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetchHandler(new Request("https://w/nope"), fakeEnv().env);
    expect(res.status).toBe(404);
  });
});
