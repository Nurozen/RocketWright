/** What the Position tab offers: anchors in words, only where the model accepts the part. */
import type { schema } from "@rw/contracts";
import { describe, expect, it } from "vitest";
import { anchorLabel, attachChoices, ownAnchorChoices } from "./positionFields.ts";

type Comp = schema.EvalComponent;

const part = (id: string, name: string, type: string, anchors: string[], attach?: string) =>
  ({ id, name, shape: { type }, anchors: anchors.map((a) => ({ name: a, kind: "axial", x: 0, r: 0 })), ...(attach === undefined ? {} : { attach: { to: attach, at: "fore", offset: 0 } }) }) as unknown as Comp;

const nose = part("nose", "Nose cone", "nose_cone", ["tip", "base"]);
const body = part("body", "Body tube", "body_tube", ["fore", "aft", "mid", "inner"], "nose.base");
const mmt = part("mmt", "Inner Tube", "inner_tube", ["fore", "aft", "inner"], "body.aft");
const block = part("block", "Engine block", "engine_block", ["fore", "aft"], "mmt.inner");
const ringA = part("ring_a", "Centering ring", "centering_ring", ["fore", "aft"], "body.aft");
const ringB = part("ring_b", "Centering ring", "centering_ring", ["fore", "aft"], "body.aft");
const lug = part("lug", "Launch lug", "launch_lug", ["fore", "aft", "mid"], "body.mid");

describe("anchor words", () => {
  it("reads as a person says it", () => {
    expect(anchorLabel("mid")).toBe("Middle");
    expect(anchorLabel("inner")).toBe("Inside");
    expect(anchorLabel("attach")).toBe("Attach point");
    expect(anchorLabel("root_te")).toBe("Root trailing edge");
    expect(anchorLabel("fin2")).toBe("Fin 2");
  });
});

describe("Attach to", () => {
  const all = [nose, body, mmt, block, ringA, ringB, lug];

  it("names each anchor by its part", () => {
    const { labels } = attachChoices(all, [lug], "body.mid");
    expect(labels["body.mid"]).toBe("Body tube: Middle");
    expect(labels["body.aft"]).toBe("Body tube: Aft");
  });

  it("leaves out the part, what is attached to it, and what cannot hold it", () => {
    const { options } = attachChoices(all, [mmt], "body.aft");
    expect(options.some((o) => o.startsWith("mmt."))).toBe(false);
    expect(options.some((o) => o.startsWith("block."))).toBe(false);
    expect(options).toContain("body.inner");
  });

  it("keeps two parts of one name apart", () => {
    const { labels } = attachChoices([body, ringA, ringB, mmt], [mmt], null);
    if (labels["ring_a.fore"] !== undefined) expect(labels["ring_b.fore"]).not.toBe(labels["ring_a.fore"]);
    const twins = attachChoices([part("a", "Tube", "body_tube", ["aft"]), part("b", "Tube", "body_tube", ["aft"]), lug], [lug], null).labels;
    expect(twins["a.aft"]).toBe("Tube: Aft");
    expect(twins["b.aft"]).toBe("Tube: Aft (2)");
  });

  it("still lists a target the part holds that the rules would leave out", () => {
    const { options, labels } = attachChoices(all, [lug], "nose.tip");
    expect(options).toContain("nose.tip");
    expect(labels["nose.tip"]).toBe("Nose cone: Tip");
  });
});

describe("Anchor", () => {
  it("offers the part's own anchors", () => {
    expect(ownAnchorChoices(part("c", "Chute", "parachute", ["attach"])).labels).toEqual({ attach: "Attach point" });
  });
});
