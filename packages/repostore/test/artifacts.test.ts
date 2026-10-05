import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactsRepoStore } from "../src/artifacts.ts";

/**
 * End-to-end test of the Artifacts adapter against a real git HTTP server and a
 * fake Artifacts binding. This proves the adapter's full path: create repo,
 * mint token, build a tree, commit, and push over smart HTTP, then read the
 * commit back.
 *
 * The only thing faked is the Artifacts binding itself (which only ever mints
 * tokens and reports the remote). Everything git-related is real.
 */

// node-git-server is a dev dependency of the spike; import dynamically so the
// package still loads if it is absent.
type GitServerLike = {
  on(event: string, cb: (ctx: { accept(): void; reject(msg?: string): void }) => void): void;
  listen(port: number, options: { type: "http" }, cb: (err?: Error) => void): void;
  close(): Promise<unknown>;
};

let server: GitServerLike | null = null;
let port = 0;

beforeAll(async () => {
  const mod = (await import("node-git-server")).default as unknown as {
    Git: new (root: string, opts?: unknown) => GitServerLike;
  };
  const root = await mkdtemp(join(tmpdir(), "hyphae-artifacts-"));
  server = new mod.Git(root, { autoCreate: true });
  server.on("push", (push) => push.accept());
  server.on("fetch", (fetch) => fetch.accept());
  port = 7200 + Math.floor(Math.random() * 1000);
  await new Promise<void>((resolve, reject) => {
    server?.listen(port, { type: "http" }, (err) => (err ? reject(err) : resolve()));
  });
});

afterAll(async () => {
  await server?.close();
});

/** A fake Artifacts binding that points at the local git server. */
function fakeArtifacts() {
  return {
    async create(name: string) {
      return {
        name,
        remote: `http://localhost:${port}/${name}.git`,
        token: "art_v1_fake?expires=9999999999",
      };
    },
    async get(name: string) {
      return {
        async info() {
          return { remote: `http://localhost:${port}/${name}.git` };
        },
        async createToken() {
          return "art_v1_fake?expires=9999999999";
        },
      };
    },
  };
}

/**
 * A fake binding matching the real workerd shape: `createToken` returns an
 * object `{ id, plaintext, scope, expiresAt }`, not a bare string. This is the
 * regression guard for the bug that made live checkpoints throw
 * `TypeError: token.split is not a function` (surfaced as error 1101).
 */
function fakeArtifactsObjectToken() {
  return {
    async create(name: string) {
      return {
        name,
        remote: `http://localhost:${port}/${name}.git`,
        token: {
          id: "tok_create",
          plaintext: "art_v2_fake_create?expires=9999999999",
          scope: "write",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
    },
    async get(name: string) {
      return {
        async info() {
          return { remote: `http://localhost:${port}/${name}.git` };
        },
        async createToken() {
          return {
            id: "tok_write",
            plaintext: "art_v2_fake_write?expires=9999999999",
            scope: "write",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        },
      };
    },
  };
}

/**
 * A fake binding whose `get` handle records disposal, matching the real
 * workerd shape where `ArtifactsRepo` implements `Disposable`. `create` returns
 * plain metadata, so only `get` handles should ever be disposed.
 */
function fakeArtifactsDisposable() {
  const disposed: string[] = [];
  return {
    disposed,
    async create(name: string) {
      return {
        name,
        remote: `http://localhost:${port}/${name}.git`,
        token: "art_v1_fake?expires=9999999999",
      };
    },
    async get(name: string) {
      return {
        async info() {
          return { remote: `http://localhost:${port}/${name}.git` };
        },
        async createToken() {
          return "art_v1_fake?expires=9999999999";
        },
        [Symbol.dispose]() {
          disposed.push(name);
        },
      };
    },
  };
}

describe("ArtifactsRepoStore: handle disposal", () => {
  it("disposes every handle it gets after a write", async () => {
    const artifacts = fakeArtifactsDisposable();
    const store = new ArtifactsRepoStore(artifacts);
    await store.writeCommit(
      "dispose1",
      null,
      [{ path: "a.txt", content: new TextEncoder().encode("hi\n") }],
      "commit",
      { name: "cman", email: "cman@example.com" },
    );
    // remoteFor and writeToken each fetched a handle; both must be released.
    expect(artifacts.disposed).toEqual(["dispose1", "dispose1"]);
  });

  it("disposes the handle even when info() throws", async () => {
    const disposed: string[] = [];
    const store = new ArtifactsRepoStore({
      async create() {
        throw new Error("unused");
      },
      async get(name: string) {
        return {
          async info(): Promise<never> {
            throw new Error("boom");
          },
          async createToken() {
            return "t";
          },
          [Symbol.dispose]() {
            disposed.push(name);
          },
        };
      },
    });
    await expect(store.readRef("infoerr", "main")).rejects.toThrow("boom");
    expect(disposed).toEqual(["infoerr"]);
  });

  it("works when a handle has no disposal member (optional chaining)", async () => {
    const store = new ArtifactsRepoStore(fakeArtifacts());
    const commit = await store.writeCommit(
      "nodispose",
      null,
      [{ path: "a.txt", content: new TextEncoder().encode("hi\n") }],
      "commit",
      { name: "cman", email: "cman@example.com" },
    );
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("ArtifactsRepoStore end-to-end", () => {
  it("creates a repo and pushes a commit over smart HTTP", async () => {
    const store = new ArtifactsRepoStore(fakeArtifacts());
    const ref = await store.createRepo("e2e");
    expect(ref.remote).toContain("e2e.git");

    const commit = await store.writeCommit(
      "e2e",
      null,
      [
        { path: "README.md", content: new TextEncoder().encode("# hello\n") },
        { path: "src/index.ts", content: new TextEncoder().encode("export const x = 1;\n") },
      ],
      "first checkpoint",
      { name: "cman", email: "cman@example.com" },
    );
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    // Read the tree back from the pushed repo.
    const tree = await store.readTree("e2e", commit);
    const paths = tree.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "src/index.ts"]);
    expect(new TextDecoder().decode(tree.find((f) => f.path === "README.md")?.content)).toBe(
      "# hello\n",
    );
  });

  it("pushes a second checkpoint commit", async () => {
    const store = new ArtifactsRepoStore(fakeArtifacts());
    await store.createRepo("e2e2");
    const first = await store.writeCommit(
      "e2e2",
      null,
      [{ path: "a.txt", content: new TextEncoder().encode("one\n") }],
      "first",
      { name: "cman", email: "cman@example.com" },
    );
    const second = await store.writeCommit(
      "e2e2",
      first,
      [
        { path: "a.txt", content: new TextEncoder().encode("two\n") },
        { path: "b.txt", content: new TextEncoder().encode("new\n") },
      ],
      "second",
      { name: "cman", email: "cman@example.com" },
    );
    expect(second).not.toBe(first);
    const tree = await store.readTree("e2e2", second);
    expect(tree.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("ArtifactsRepoStore: deletions", () => {
  it("persists an all-delete checkpoint", async () => {
    const store = new ArtifactsRepoStore(fakeArtifacts());
    await store.createRepo("delall");
    const enc = new TextEncoder();
    const c1 = await store.writeCommit(
      "delall",
      null,
      [
        { path: "a.txt", content: enc.encode("aaa") },
        { path: "b.txt", content: enc.encode("bbb") },
      ],
      "initial",
      { name: "cman", email: "cman@example.com" },
    );
    expect((await store.readTree("delall", c1)).length).toBe(2);

    // Everything deleted.
    const c2 = await store.writeCommit("delall", c1, [], "all gone", {
      name: "cman",
      email: "cman@example.com",
    });
    expect((await store.readTree("delall", c2)).length).toBe(0);
  });
});

describe("ArtifactsRepoStore: workerd token shape", () => {
  it("commits when createToken returns an object, not a string", async () => {
    const store = new ArtifactsRepoStore(fakeArtifactsObjectToken());
    const ref = await store.createRepo("objtok");
    expect(ref.remote).toContain("objtok.git");

    const enc = new TextEncoder();
    const commit = await store.writeCommit(
      "objtok",
      null,
      [{ path: "hello.txt", content: enc.encode("hello\nworld\n") }],
      "object token commit",
      { name: "cman", email: "cman@example.com" },
    );
    expect(typeof commit).toBe("string");
    const tree = await store.readTree("objtok", commit);
    expect(tree.length).toBe(1);
    expect(new TextDecoder().decode(tree[0]?.content)).toBe("hello\nworld\n");
  });
});
