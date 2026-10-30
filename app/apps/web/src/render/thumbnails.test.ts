/** M3.6 part thumbnails: keys and subjects (the GPU render is covered by e2e/thumbnails.spec.ts). */
import { readFileSync } from "node:fs";
import type { EvaluatedModel } from "@rw/contracts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { glbModelHash } from "../viewport/glb-source.ts";
import { AssemblyModel } from "../viewport/scene.ts";
import { bakeKeys, parseThumbKey, SNAPSHOT_KEY, thumbKey, thumbKeys, thumbSubject, THUMB_SIZES } from "./thumbnails.ts";

const repo = new URL("../../../../../", import.meta.url);
const glbBytes = readFileSync(new URL("app/apps/web/public/fixtures/contract-vehicle.glb", repo));
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;

async function fixtureModel(): Promise<AssemblyModel> {
  const ab = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(ab, "");
  const meta = Object.fromEntries(evaluated.components.map((c) => [c.id, { name: c.name, appearance: c.appearance ?? null, parent: c.parent ?? null }]));
  return new AssemblyModel(gltf.scene, meta, glbModelHash(glbBytes));
}

describe("thumbnail keys", () => {
  it("are the component id (tree) and <id>--card, and parse back", () => {
    expect(thumbKey("recovery_bay")).toBe("recovery_bay");
    expect(thumbKey("recovery_bay", "card")).toBe("recovery_bay--card");
    expect(parseThumbKey("recovery_bay--card")).toEqual({ id: "recovery_bay", variant: "card" });
    expect(parseThumbKey("fins")).toEqual({ id: "fins", variant: "tree" });
    expect(thumbKeys(["a", "b"])).toEqual(["a", "a--card", "b", "b--card"]);
    // Keys are valid cache file names (server ThumbCache: [A-Za-z0-9_-]).
    for (const k of thumbKeys(evaluated.components.map((c) => c.id))) expect(k).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(THUMB_SIZES.card[0] / THUMB_SIZES.card[1]).toBe(2);
    // The Results snapshot: one key for the whole rocket, kept current with the parts.
    expect(thumbKey("anything", "snap")).toBe(SNAPSHOT_KEY);
    expect(parseThumbKey(SNAPSHOT_KEY)).toEqual({ id: "", variant: "snap" });
    expect(bakeKeys(["a"])).toEqual(["a", "a--card", SNAPSHOT_KEY]);
    expect(SNAPSHOT_KEY).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});

describe("thumbnail subjects", () => {
  it("draw a part alone, and a clear carrier with the contents riding in it", async () => {
    const m = await fixtureModel();
    const clear = [...m.parts.values()].find((p) => p.look.clear);
    expect(clear, "the contract vehicle has a clear bay").toBeDefined();
    const subject = thumbSubject(m, clear!.id);
    expect(subject[0]).toBe(clear!.id);
    expect(subject.length).toBeGreaterThan(1);
    for (const rider of subject.slice(1)) expect(m.plan.follows.get(rider)).toBe(clear!.id);
    const opaque = [...m.parts.values()].find((p) => !p.look.clear)!;
    expect(thumbSubject(m, opaque.id)).toEqual([opaque.id]);
    expect(thumbSubject(m, "no-such-part")).toEqual([]);
    m.dispose();
  });
});
