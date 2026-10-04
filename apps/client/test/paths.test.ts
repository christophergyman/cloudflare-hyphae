import { describe, expect, it } from "bun:test";
import { PathJailError, resolveSafePath } from "../src/paths.ts";

describe("resolveSafePath (path jail)", () => {
  const root = "/project";

  it("resolves a normal relative path inside the root", () => {
    expect(resolveSafePath(root, "src/index.ts")).toBe("/project/src/index.ts");
  });

  it("rejects absolute paths", () => {
    expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(PathJailError);
  });

  it("rejects parent traversal", () => {
    expect(() => resolveSafePath(root, "../secrets")).toThrow(PathJailError);
    expect(() => resolveSafePath(root, "src/../../x")).toThrow(PathJailError);
  });

  it("rejects writes into .git", () => {
    expect(() => resolveSafePath(root, ".git/config")).toThrow(PathJailError);
    expect(() => resolveSafePath(root, "src/.git/hooks/pre-commit")).toThrow(PathJailError);
  });

  it("rejects empty and dot segments", () => {
    expect(() => resolveSafePath(root, "")).toThrow(PathJailError);
    expect(() => resolveSafePath(root, "a//b")).toThrow(PathJailError);
    expect(() => resolveSafePath(root, "./a")).toThrow(PathJailError);
  });

  it("rejects windows-style absolute paths", () => {
    expect(() => resolveSafePath(root, "C:\\Windows\\system32")).toThrow(PathJailError);
  });
});
