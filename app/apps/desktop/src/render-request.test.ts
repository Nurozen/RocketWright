import { describe, expect, it } from "vitest";
import { parseRequest } from "./render-request.ts";

describe("rocketwright-render stdin (RL3)", () => {
  const ok = { schema: "rw/1", view: "iso", width: 64, height: 32, evaluated: { components: [] } };

  it("accepts a RenderRequest", () => {
    expect(parseRequest(JSON.stringify(ok))).toMatchObject({ view: "iso", width: 64, height: 32 });
  });

  it("rejects empty, malformed, and out-of-range requests", () => {
    expect(() => parseRequest(" \n")).toThrow(/no RenderRequest/);
    expect(() => parseRequest("{")).toThrow();
    expect(() => parseRequest("[1]")).toThrow(/view/);
    expect(() => parseRequest(JSON.stringify({ ...ok, view: undefined }))).toThrow(/view/);
    expect(() => parseRequest(JSON.stringify({ ...ok, width: 0 }))).toThrow(/width/);
    expect(() => parseRequest(JSON.stringify({ ...ok, height: 9000 }))).toThrow(/height/);
    expect(() => parseRequest(JSON.stringify({ ...ok, height: 1.5 }))).toThrow(/height/);
    expect(() => parseRequest(JSON.stringify({ ...ok, evaluated: null }))).toThrow(/evaluated/);
  });
});
