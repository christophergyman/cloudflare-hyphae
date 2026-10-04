import { describe, expect, it } from "bun:test";
import { MemoryFS } from "../src/memory-fs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("MemoryFS", () => {
  it("writes and reads a file", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/w/a.txt", "hello\n");
    expect(dec.decode((await fs.promises.readFile("/w/a.txt")) as Uint8Array)).toBe("hello\n");
  });

  it("creates parent directories recursively", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/w/deep/nested/file.ts", "x");
    expect(await fs.promises.readdir("/w/deep/nested")).toEqual(["file.ts"]);
    expect(await fs.promises.readdir("/w/deep")).toEqual(["nested"]);
  });

  it("reports directory and file stats", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/w/a.txt", "abc");
    const st = await fs.promises.lstat("/w/a.txt");
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.size).toBe(3);
    const dir = await fs.promises.stat("/w");
    expect(dir.isDirectory()).toBe(true);
  });

  it("lists directory contents sorted", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/w/b.txt", "b");
    await fs.promises.writeFile("/w/a.txt", "a");
    expect(await fs.promises.readdir("/w")).toEqual(["a.txt", "b.txt"]);
  });

  it("unlinks a file", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/w/a.txt", "a");
    await fs.promises.unlink("/w/a.txt");
    expect(await fs.promises.readdir("/w")).toEqual([]);
  });

  it("throws ENOENT for a missing file", async () => {
    const fs = new MemoryFS();
    await expect(fs.promises.readFile("/w/nope")).rejects.toThrow("ENOENT");
  });

  it("copies written buffers (no aliasing)", async () => {
    const fs = new MemoryFS();
    const buf = enc.encode("orig");
    await fs.promises.writeFile("/w/a.txt", buf);
    buf.set(enc.encode("mut!"));
    expect(dec.decode((await fs.promises.readFile("/w/a.txt")) as Uint8Array)).toBe("orig");
  });
});

describe("MemoryFS read-side safety", () => {
  it("does not alias the internal buffer on read", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/w/a.txt", new Uint8Array([1, 2, 3]));
    const first = (await fs.promises.readFile("/w/a.txt")) as Uint8Array;
    first[0] = 99;
    const second = (await fs.promises.readFile("/w/a.txt")) as Uint8Array;
    expect(Array.from(second)).toEqual([1, 2, 3]);
  });
});
