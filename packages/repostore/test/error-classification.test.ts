import { describe, expect, it } from "bun:test";
import { isMissingRefError } from "../src/artifacts.ts";

/**
 * The classification that separates "the ref does not exist yet" (return null)
 * from "something went wrong" (propagate). Getting this wrong converts a
 * transient failure into silent history loss, so it is tested directly.
 */
describe("isMissingRefError", () => {
  it("treats a missing ref/object as not-an-error", () => {
    expect(isMissingRefError(Object.assign(new Error("x"), { code: "NotFoundError" }))).toBe(true);
    expect(isMissingRefError(Object.assign(new Error("x"), { code: "ResolveRefError" }))).toBe(
      true,
    );
  });

  it("treats an HTTP 404 from the remote as not-an-error", () => {
    expect(
      isMissingRefError(Object.assign(new Error("404"), { code: "HttpError", statusCode: 404 })),
    ).toBe(true);
  });

  it("propagates anything else", () => {
    expect(
      isMissingRefError(Object.assign(new Error("401"), { code: "HttpError", statusCode: 401 })),
    ).toBe(false);
    expect(isMissingRefError(new Error("network down"))).toBe(false);
    expect(isMissingRefError(undefined)).toBe(false);
    expect(isMissingRefError("boom")).toBe(false);
  });
});
