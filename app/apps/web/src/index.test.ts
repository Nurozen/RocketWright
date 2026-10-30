import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

describe("@rw/web", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@rw/web");
  });
});
