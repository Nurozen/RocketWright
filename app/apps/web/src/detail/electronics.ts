/**
 * Electronics (RL5): the avionics-bay sleeve with a window facing the viewer,
 * its end plates and threaded rods, and the flight computer sled (PCB with
 * parts, silkscreen and traces, header pins, terminals, and a battery).
 * Visual tier only (I13): the mass component's mass and CG stay in the model.
 */
import * as THREE from "three/webgpu";
import { merge, revolve, roundedBox, tubeProfile } from "./bevel.ts";
import { dim } from "./dims.ts";
import { placeAtRoll, rollToward } from "./fittings.ts";
import { hexNut, threadedRod } from "./hardware.ts";
import type { DetailContext, DetailResult } from "./types.ts";

/** Window angular width (rad) and end-band fraction of the sleeve. */
export const EBAY_WINDOW = { angle: (110 * Math.PI) / 180, band: 0.17 };

/** Flat quad from four body-frame corners (a window side face). */
function quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Avionics-bay sleeve (coupler) with a viewing window, end plates, and two rods. */
export function electronicsBayDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const ro = dim(c, "od") / 2;
  const ri = dim(c, "id") / 2 || 0.95 * ro;
  const len = c.x_aft - c.x_fore;
  if (!(ro > 0) || !(len > 0)) return null;
  const seg = ctx.segments;
  const phiW = rollToward(ctx.showcase);
  const w = EBAY_WINDOW.angle;
  const band = EBAY_WINDOW.band * len;
  const wall = Math.max(ro - ri, 0.0004);
  const machined = ctx.materials.finish("machined");
  const parts: THREE.BufferGeometry[] = [];
  for (const [x0, x1] of [
    [c.x_fore, c.x_fore + band],
    [c.x_aft - band, c.x_aft],
  ] as const) {
    const p = tubeProfile({ x0, x1, ro, ri, bevel: 0.45 * wall, grooves: [0.5], grooveDepth: Math.min(0.3 * wall, 0.0003), grooveWidth: 0.0003 });
    parts.push(revolve(p.points, { segments: seg, closed: true }));
  }
  const mid = tubeProfile({ x0: c.x_fore + band, x1: c.x_aft - band, ro, ri, bevel: 0 });
  parts.push(revolve(mid.points, { segments: seg, closed: true, phiStart: phiW + w / 2, phiLength: 2 * Math.PI - w }));
  for (const phi of [phiW + w / 2, phiW - w / 2]) {
    const rad = (r: number, x: number) => new THREE.Vector3(x, r * Math.cos(phi), r * Math.sin(phi));
    const xa = c.x_fore + band;
    const xb = c.x_aft - band;
    parts.push(quad(rad(ri, xa), rad(ro, xa), rad(ro, xb), rad(ri, xb)));
  }
  const group = new THREE.Group();
  const sleeve = new THREE.Mesh(merge(parts), machined);
  sleeve.name = "ebay-sleeve";
  // End plates just inside the bands, with rods and nuts.
  const plateT = Math.min(0.003, 0.25 * band);
  const plates: THREE.BufferGeometry[] = [];
  for (const [x0, x1] of [
    [c.x_fore + 0.25 * band, c.x_fore + 0.25 * band + plateT],
    [c.x_aft - 0.25 * band - plateT, c.x_aft - 0.25 * band],
  ] as const) {
    const p = tubeProfile({ x0, x1, ro: ri - 0.0002, ri: 0, bevel: 0.3 * plateT });
    plates.push(revolve(p.points, { segments: seg }));
  }
  const plateMesh = new THREE.Mesh(merge(plates), ctx.materials.finish("anodized_dark"));
  plateMesh.name = "ebay-plates";
  const rodR = Math.max(0.0008, 0.055 * ri);
  const rods: THREE.BufferGeometry[] = [];
  const nuts: THREE.BufferGeometry[] = [];
  const xa = c.x_fore + 0.25 * band;
  const xb = c.x_aft - 0.25 * band;
  for (const side of [-1, 1]) {
    // Behind the board (away from the window), either side of it.
    const phi = phiW + Math.PI + side * 0.95;
    const y = 0.62 * ri * Math.cos(phi);
    const z = 0.62 * ri * Math.sin(phi);
    rods.push(threadedRod(xa - 0.004, xb + 0.004, rodR, Math.max(0.0008, 0.9 * rodR), y, z));
    for (const x of [xa - 0.0015, xb + 0.0015]) nuts.push(hexNut(x, 1.5 * rodR, 3.4 * rodR, 0.9 * rodR, y, z));
  }
  const rodMesh = new THREE.Mesh(merge(rods), ctx.materials.finish("thread"));
  rodMesh.name = "ebay-rods";
  const nutMesh = new THREE.Mesh(merge(nuts), machined);
  nutMesh.name = "ebay-nuts";
  group.add(sleeve, plateMesh, rodMesh, nutMesh);
  return { group, outline: [sleeve] };
}

/** Silkscreen and copper traces for the board's top face. */
function drawPcb(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = "#1d6a3c";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(160, 205, 120, 0.55)";
  g.lineWidth = 2;
  // Deterministic traces: a few dog-legs between pad rows.
  for (let k = 0; k < 14; k++) {
    const y0 = ((k * 37) % (h - 16)) + 8;
    const x0 = 10 + ((k * 53) % 60);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 + 40 + ((k * 29) % 70), y0);
    g.lineTo(x0 + 60 + ((k * 29) % 70), y0 + (k % 2 === 0 ? 14 : -14));
    g.lineTo(w - 12 - ((k * 17) % 50), y0 + (k % 2 === 0 ? 14 : -14));
    g.stroke();
  }
  g.fillStyle = "rgba(220, 190, 110, 0.9)";
  for (let k = 0; k < 10; k++) g.fillRect(w - 18, 10 + k * ((h - 20) / 10), 8, 6);
  g.fillStyle = "rgba(240, 240, 235, 0.85)";
  g.font = "bold 18px sans-serif";
  g.fillText("RW-FC1", 14, h - 12);
  g.strokeStyle = "rgba(240, 240, 235, 0.7)";
  g.lineWidth = 1.5;
  g.strokeRect(4, 4, w - 8, h - 8);
}

/** Battery label wrap. */
function drawBattery(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = "#e9e6df";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#1d3f73";
  g.fillRect(0, 0, w, h * 0.28);
  g.fillRect(0, h * 0.72, w, h * 0.28);
  g.fillStyle = "#1d3f73";
  g.font = "bold 22px sans-serif";
  g.fillText("9V  Li", 12, h * 0.6);
}

/**
 * Flight computer on a sled: the board faces the bay window (the viewer),
 * populated with an MCU, sensors, header pins, screw terminals, and a
 * battery at the aft end. Sized from the carrier bore and the component length.
 */
export function flightComputerDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const carrier = c.parent ? ctx.lookup(c.parent) : undefined;
  const bore = (carrier ? dim(carrier, "id") / 2 : 0) || dim(c, "od") / 2;
  const len = c.x_aft - c.x_fore;
  if (!(bore > 0) || !(len > 0)) return null;
  const phiW = rollToward(ctx.showcase);
  const d = 0.16 * bore;
  const bw = 2 * Math.sqrt(bore * bore - d * d) * 0.84;
  const bl = 0.96 * len;
  const bt = 0.0016;
  const x0 = c.x_fore + 0.02 * len;
  const xm = x0 + bl / 2;
  const top = bt / 2;
  const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
  const group = new THREE.Group();
  const mats = ctx.materials;

  const board = new THREE.Mesh(placeAtRoll(at(roundedBox(bl, bt, bw, 0.0005), xm, 0, 0), phiW, d), mats.canvas("pcb", drawPcb, 512, 256));
  board.name = "fc-board";
  const sled = new THREE.Mesh(placeAtRoll(at(roundedBox(bl * 1.02, 0.0012, bw * 0.7, 0.0004), xm, -bt - 0.0006, 0), phiW, d), mats.finish("anodized_dark"));
  sled.name = "fc-sled";

  const chips: THREE.BufferGeometry[] = [];
  const chip = (fx: number, fz: number, sx: number, sz: number, h: number) => chips.push(at(roundedBox(sx, h, sz, 0.0002), x0 + fx * bl, top + h / 2, fz * bw));
  chip(0.16, -0.12, 0.009, 0.009, 0.0012);
  chip(0.3, 0.18, 0.004, 0.004, 0.0014);
  chip(0.3, -0.24, 0.005, 0.003, 0.001);
  chip(0.42, 0.02, 0.006, 0.0035, 0.001);
  chip(0.07, 0.24, 0.003, 0.005, 0.0012);
  const chipMesh = new THREE.Mesh(placeAtRoll(merge(chips), phiW, d), mats.finish("chip"));
  chipMesh.name = "fc-chips";

  const pins: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) pins.push(at(roundedBox(0.0007, 0.0028, 0.0007, 0.0001, 1), x0 + 0.08 * bl + k * 0.00254, top + 0.0014, 0.41 * bw));
  const pinMesh = new THREE.Mesh(placeAtRoll(merge(pins), phiW, d), mats.finish("gold"));
  pinMesh.name = "fc-header";

  const term: THREE.BufferGeometry[] = [];
  for (const fz of [-0.3, 0.05]) term.push(at(roundedBox(0.005, 0.0055, 0.0075, 0.0005), x0 + 0.53 * bl, top + 0.00275, fz * bw));
  const termMesh = new THREE.Mesh(placeAtRoll(merge(term), phiW, d), mats.finish("battery"));
  termMesh.name = "fc-terminals";

  // Battery at the aft end of the board.
  const batL = Math.min(0.026, 0.4 * bl);
  const batH = Math.min(0.0085, Math.sqrt(bore * bore - (0.3 * bw) ** 2) - d - top - 0.001);
  const batW = Math.min(0.0175, 0.6 * bw);
  const batX = x0 + bl - batL / 2 - 0.02 * bl;
  const battery = new THREE.Mesh(placeAtRoll(at(roundedBox(batL, batH, batW, 0.0012), batX, top + batH / 2, -0.05 * bw), phiW, d), mats.canvas("battery", drawBattery, 256, 128));
  battery.name = "fc-battery";
  const clip = new THREE.Mesh(placeAtRoll(at(roundedBox(0.0035, batH + 0.0012, batW + 0.0016, 0.0004), batX, top + batH / 2, -0.05 * bw), phiW, d), mats.finish("machined"));
  clip.name = "fc-battery-strap";

  group.add(sled, board, chipMesh, pinMesh, termMesh, battery, clip);
  return { group, outline: [board, battery] };
}
