import { afterAll, describe, expect, it, mock } from "bun:test";

/**
 * Edge Worker tests.
 *
 * `agents` and `@hyphae/hub` are Cloudflare-runtime modules: importing them
 * pulls in the `cloudflare:workers` virtual module, which does not exist under
 * `bun test`. They are stubbed here so the real routing logic in `src/index.ts`
 * can run unmodified. The handler under test is the production one; only the
 * runtime bindings it delegates to are faked.
 */

mock.module("agents", () => ({
  routeAgentRequest: async () => undefined,
}));

mock.module("@hyphae/hub", () => ({
  Hub: class {},
}));

const { default: worker } = await import("../src/index.ts");
type Env = import("../src/index.ts").Env;

afterAll(() => {
  mock.restore();
});

/** Fake bindings the edge handler uses. Only the surface it touches is built. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  const blobs = new Map<string, Uint8Array>();
  const env = {
    BLOBS: {
      async put(key: string, value: Uint8Array) {
        blobs.set(key, value.slice());
        return {};
      },
      async get(key: string) {
        const value = blobs.get(key);
        if (!value) return null;
        return { arrayBuffer: async () => value.slice().buffer };
      },
    },
    Hub: {
      idFromName: (name: string) => name,
      get: () => ({
        async checkpoint() {
          return { ok: true, committed: 0 };
        },
        async manifest() {
          return { files: [] };
        },
        async recentEvents() {
          return [];
        },
      }),
    },
    ASSETS: {
      async fetch() {
        return new Response("static asset", { status: 200 });
      },
    },
    ...overrides,
  };
  return env as unknown as Env;
}

describe("edge worker", () => {
  it("GET /health reports ok", async () => {
    const res = await worker.fetch(new Request("https://edge.test/health"), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("hyphae-edge");
  });

  it("PUT /blobs then GET /blobs/:hash round-trips the bytes", async () => {
    const env = makeEnv();
    const bytes = new TextEncoder().encode("hello blob\n");

    const put = await worker.fetch(
      new Request("https://edge.test/blobs", { method: "PUT", body: bytes }),
      env,
    );
    expect(put.status).toBe(200);
    const { hash } = (await put.json()) as { hash: string };
    expect(hash).toBeTruthy();

    const get = await worker.fetch(new Request(`https://edge.test/blobs/${hash}`), env);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a body over the 1.5MB cap with 413", async () => {
    const env = makeEnv();
    const tooBig = new Uint8Array(1_500_001);
    const req = new Request("https://edge.test/blobs", {
      method: "PUT",
      body: tooBig,
      headers: { "content-length": String(tooBig.byteLength) },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("payload_too_large");
    expect(body.limit).toBe(1_500_000);
  });

  it("falls through to ASSETS for an unknown path", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://edge.test/some/app/route"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("static asset");
  });
});
