// Ported from three.js (MIT) examples/webgpu_compute_particles_fluid.html (r186)
/**
 * Page 06 GPU fluid (M5.2): MLS-MPM in TSL compute shaders, in a tank SDF,
 * driven by the body-frame specific force (the liquid settles along its
 * opposite) and drained to the engineering run's fill fraction.
 *
 * Ported from three.js (MIT) examples/webgpu_compute_particles_fluid.html
 * (r186: the five-kernel MLS-MPM with fixed-point atomics, itself after
 * matsuoka-601/WebGPU-Ocean, MIT); see NOTICE.md. Changes: a non-cubic grid
 * in cell units over the tank, the tank SDF as the boundary (instead of the
 * rounded box), a gravity vector uniform, an active-particle count for
 * draining (particles past it are skipped), CPU seeding of the settled
 * state on a seek, two substeps per frame, and a smoothed density field in
 * a 3D storage texture. The drawn liquid (`surface.ts`) is the tank below a
 * plane fitted over the particles' top layer (`freeSurface.ts`), read back
 * with `readParticles`.
 *
 * Visual tier only (I13): an illustrative particle fluid, not CFD.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs are untyped at this level */
import * as TSL from "three/tsl";
import * as THREE from "three/webgpu";
import { activeCount, axialHalf, fillOf, seedSettled, type FluidGrid, type TankShape, type Vec3 } from "./tankSdf.ts";

type N = any;

/** TSL builders, untyped: the node graphs here outgrow the published overloads. */
const {
  Fn,
  If,
  Loop,
  Return,
  array,
  atomicAdd,
  atomicLoad,
  atomicStore,
  clamp,
  float,
  instanceIndex,
  instancedArray,
  int,
  ivec3,
  mat3,
  max,
  pow,
  struct,
  textureStore,
  uniform,
  uvec3,
  vec3,
  vec4,
} = TSL as N;

/** Floats per particle: position vec3 + velocity vec3 + C mat3, padded (WGSL alignment: vec3 = 4, mat3 = 12). */
export const PARTICLE_STRIDE = 20;
/** Fixed-point scale for the atomic grid sums (int32: ±1073 per cell, room for the stiffer pressure). */
const FIXED_POINT = 2e6;
const WORKGROUP = 64;
const G0 = 9.80665;
/** Substeps per `step` (the sound speed of the stiffer liquid needs dt ≤ 1/240 s). */
export const SUBSTEPS = 4;
/** Particles stay this far inside the wall (cells). */
const SKIN = 0.75;

export interface FluidParams {
  /** Equation of state p = k ((ρ/ρ0)^5 - 1), grid units. */
  stiffness: number;
  restDensity: number;
  viscosity: number;
  /** Cap on the pressure (keeps the fixed-point sums in range). */
  maxPressure: number;
  /** Grid velocity damping, 1/s (calms the stiff liquid's noise). */
  damping: number;
  /** Apparent gravity for 1 g, cells/s². */
  gravity: number;
}

/**
 * Tuned live (apple metal-3, 32k particles): stiff enough that the liquid
 * keeps its volume (under ~15 % compression at the bottom of the tank, so it
 * looks as full as the fill fraction says; the example's stiffness 50 under
 * 9.81² cells/s² compressed it about twofold), damped enough that the stiff
 * equation of state does not boil, and slow enough (1 g = 30 cells/s²) that
 * sloshing reads at study speed.
 */
export const DEFAULT_PARAMS: FluidParams = { stiffness: 1000, restDensity: 1.5, viscosity: 0.2, maxPressure: 4000, damping: 1, gravity: 30 };

/** Grid cells lighter than this are empty (their momentum / mass is fixed-point noise). */
const MIN_CELL_MASS = 1e-3;

export class FluidSim {
  readonly grid: FluidGrid;
  readonly shape: TankShape;
  /** Smoothed density over rest density, one texel per grid node (r channel). */
  readonly densityTexture: THREE.Storage3DTexture;
  private readonly particles: N;
  private readonly kernels: { clear: N; p2g1: N; p2g2: N; update: N; g2p: N; density: N };
  private readonly u: { active: N; gravity: N; dt: N };
  private activeN = 0;
  private readonly gScale: number;
  private readonly substeps: number;
  private readonly dampRate: number;
  private readonly dampU: N;
  private stepCount = 0;

  constructor(grid: FluidGrid, shape: TankShape, params: FluidParams = DEFAULT_PARAMS) {
    this.gScale = params.gravity;
    this.substeps = SUBSTEPS;
    this.dampRate = params.damping;
    this.grid = grid;
    this.shape = shape;
    const [gx, gy, gz] = grid.dims;
    const cellCount = gx * gy * gz;
    const nMax = grid.maxParticles;

    const particleStruct = struct({ position: { type: "vec3" }, velocity: { type: "vec3" }, C: { type: "mat3" } });
    this.particles = instancedArray(new Float32Array(nMax * PARTICLE_STRIDE), particleStruct as N);
    const cellStruct = struct({
      x: { type: "int", atomic: true },
      y: { type: "int", atomic: true },
      z: { type: "int", atomic: true },
      mass: { type: "int", atomic: true },
    });
    const cells: N = instancedArray(cellCount, cellStruct as N);
    const cellsF: N = instancedArray(cellCount, "vec4");

    const tex = new THREE.Storage3DTexture(gx, gy, gz);
    tex.type = THREE.HalfFloatType;
    tex.format = THREE.RGBAFormat;
    tex.generateMipmaps = false;
    tex.name = "fluidDensity";
    this.densityTexture = tex;

    const active: N = uniform(0, "uint");
    const gravity: N = uniform(new THREE.Vector3(0, 0, -params.gravity));
    const dt: N = uniform(1 / 120);
    const stiffness: N = uniform(params.stiffness);
    const restDensity: N = uniform(params.restDensity);
    const viscosity: N = uniform(params.viscosity);
    const pmax: N = uniform(params.maxPressure);
    const minMass: N = uniform(MIN_CELL_MASS);
    const damping: N = uniform(1);
    this.dampU = damping;
    this.u = { active, gravity, dt };

    const enc = (f: N): N => int(f.mul(FIXED_POINT));
    const dec = (i: N): N => float(i).div(FIXED_POINT);
    const ptr = (c: N): N => c.x.mul(int(gy * gz)).add(c.y.mul(int(gz))).add(c.z);
    const P: N = this.particles;
    const weightsAt = (gridPosition: N): N => {
      const d = gridPosition.fract().sub(0.5).toConst("cellDiff");
      const w0 = float(0.5).mul(float(0.5).sub(d)).mul(float(0.5).sub(d));
      const w1 = float(0.75).sub(d.mul(d));
      const w2 = float(0.5).mul(float(0.5).add(d)).mul(float(0.5).add(d));
      return array([w0, w1, w2]).toConst("weights");
    };
    const stencil = (body: (gx: N, gy: N, gz: N) => void): void => {
      Loop({ start: 0, end: 3, type: "int", name: "gx", condition: "<" }, ({ gx: ix }: N) => {
        Loop({ start: 0, end: 3, type: "int", name: "gy", condition: "<" }, ({ gy: iy }: N) => {
          Loop({ start: 0, end: 3, type: "int", name: "gz", condition: "<" }, ({ gz: iz }: N) => {
            body(ix, iy, iz);
          });
        });
      });
    };
    const skipInactive = (): void => {
      If(instanceIndex.greaterThanEqual(active), () => {
        Return();
      });
    };

    const clear = (Fn as N)(() => {
      const c = cells.element(instanceIndex);
      atomicStore(c.get("x"), 0);
      atomicStore(c.get("y"), 0);
      atomicStore(c.get("z"), 0);
      atomicStore(c.get("mass"), 0);
    })()
      .compute(cellCount)
      .setName("fluidClear");

    const p2g1 = (Fn as N)(() => {
      skipInactive();
      const position = P.element(instanceIndex).get("position").toConst("position");
      const velocity = P.element(instanceIndex).get("velocity").toConst("velocity");
      const C = P.element(instanceIndex).get("C").toConst("C");
      const cellIndex = ivec3(position).sub(1).toConst("cellIndex");
      const w = weightsAt(position);
      stencil((ix, iy, iz) => {
        const weight = w.element(ix).x.mul(w.element(iy).y).mul(w.element(iz).z);
        const cellX = cellIndex.add(ivec3(ix, iy, iz)).toConst();
        const cellDist = vec3(cellX).add(0.5).sub(position).toConst("cellDist");
        const Q = C.mul(cellDist);
        const vel = weight.mul(velocity.add(Q)).toConst("velContrib");
        const c = cells.element(ptr(cellX));
        atomicAdd(c.get("x"), enc(vel.x));
        atomicAdd(c.get("y"), enc(vel.y));
        atomicAdd(c.get("z"), enc(vel.z));
        atomicAdd(c.get("mass"), enc(weight));
      });
    })()
      .compute(nMax, [WORKGROUP, 1, 1])
      .setName("fluidP2G1");

    const p2g2 = (Fn as N)(() => {
      skipInactive();
      const position = P.element(instanceIndex).get("position").toConst("position");
      const cellIndex = ivec3(position).sub(1).toConst("cellIndex");
      const w = weightsAt(position);
      const density = float(0).toVar("density");
      stencil((ix, iy, iz) => {
        const weight = w.element(ix).x.mul(w.element(iy).y).mul(w.element(iz).z);
        const cellX = cellIndex.add(ivec3(ix, iy, iz)).toConst();
        density.addAssign(dec(atomicLoad(cells.element(ptr(cellX)).get("mass"))).mul(weight));
      });
      const volume = float(1).div(max(density, 1e-6));
      const pressure = clamp(pow(density.div(restDensity), 5.0).sub(1).mul(stiffness), 0.0, pmax).toConst("pressure");
      const stress = mat3(pressure.negate(), 0, 0, 0, pressure.negate(), 0, 0, 0, pressure.negate()).toVar("stress");
      const dudv = P.element(instanceIndex).get("C").toConst("dudv");
      stress.addAssign(dudv.add(dudv.transpose()).mul(viscosity));
      const term0 = volume.mul(-4).mul(stress).mul(dt);
      stencil((ix, iy, iz) => {
        const weight = w.element(ix).x.mul(w.element(iy).y).mul(w.element(iz).z);
        const cellX = cellIndex.add(ivec3(ix, iy, iz)).toConst();
        const cellDist = vec3(cellX).add(0.5).sub(position).toConst("cellDist");
        const momentum = term0.mul(weight).mul(cellDist).toConst("momentum");
        const c = cells.element(ptr(cellX));
        atomicAdd(c.get("x"), enc(momentum.x));
        atomicAdd(c.get("y"), enc(momentum.y));
        atomicAdd(c.get("z"), enc(momentum.z));
      });
    })()
      .compute(nMax, [WORKGROUP, 1, 1])
      .setName("fluidP2G2");

    const update = (Fn as N)(() => {
      const c = cells.element(instanceIndex);
      const mass = dec(atomicLoad(c.get("mass"))).toConst("mass");
      // Cells at the stencil's edge carry a sliver of mass: their momentum / mass is fixed-point
      // noise, and kicks particles. Treat them as empty.
      If(mass.lessThanEqual(minMass), () => {
        cellsF.element(instanceIndex).assign(vec4(0));
        Return();
      });
      const vx = dec(atomicLoad(c.get("x"))).div(mass).toVar();
      const vy = dec(atomicLoad(c.get("y"))).div(mass).toVar();
      const vz = dec(atomicLoad(c.get("z"))).div(mass).toVar();
      const x = int(instanceIndex).div(int(gz * gy));
      const y = int(instanceIndex).div(int(gz)).mod(int(gy));
      const z = int(instanceIndex).mod(int(gz));
      If(x.lessThan(int(1)).or(x.greaterThan(int(gx - 2))), () => {
        vx.assign(0);
      });
      If(y.lessThan(int(1)).or(y.greaterThan(int(gy - 2))), () => {
        vy.assign(0);
      });
      If(z.lessThan(int(1)).or(z.greaterThan(int(gz - 2))), () => {
        vz.assign(0);
      });
      cellsF.element(instanceIndex).assign(vec4(vec3(vx, vy, vz).mul(damping), mass));
    })()
      .compute(cellCount)
      .setName("fluidGrid");

    // The tank wall in grid units: a capsule (or a capped cylinder) along x.
    const centre = vec3(gx / 2, gy / 2, gz / 2);
    const rIn = shape.radius / grid.h - SKIN;
    const hLen = shape.halfLength / grid.h;
    const capsule = shape.capsule;
    const intoTank = (p: N): N => {
      const q = p.sub(centre).toVar();
      const out = q.toVar();
      if (capsule) {
        const a = vec3(clamp(q.x, -hLen, hLen), 0, 0);
        const v = q.sub(a);
        const len = v.length().toVar();
        If(len.greaterThan(rIn), () => {
          out.assign(a.add(v.div(len).mul(rIn)));
        });
      } else {
        const ax = clamp(q.x, -(hLen - SKIN), hLen - SKIN);
        const rv = vec3(0, q.y, q.z);
        const rl = rv.length().toVar();
        out.assign(vec3(ax, q.y, q.z));
        If(rl.greaterThan(rIn), () => {
          out.assign(vec3(ax, rv.y.div(rl).mul(rIn), rv.z.div(rl).mul(rIn)));
        });
      }
      return out.add(centre);
    };

    const g2p = (Fn as N)(() => {
      skipInactive();
      const position = P.element(instanceIndex).get("position").toVar("position");
      const velocity = vec3(0).toVar("velocity");
      const cellIndex = ivec3(position).sub(1).toConst("cellIndex");
      const w = weightsAt(position);
      const B = mat3(0).toVar("B");
      stencil((ix, iy, iz) => {
        const weight = w.element(ix).x.mul(w.element(iy).y).mul(w.element(iz).z);
        const cellX = cellIndex.add(ivec3(ix, iy, iz)).toConst();
        const cellDist = vec3(cellX).add(0.5).sub(position).toConst("cellDist");
        const wv = cellsF.element(ptr(cellX)).xyz.mul(weight).toConst("weightedVelocity");
        B.addAssign(mat3(wv.mul(cellDist.x), wv.mul(cellDist.y), wv.mul(cellDist.z)));
        velocity.addAssign(wv);
      });
      P.element(instanceIndex).get("C").assign(B.mul(4));
      velocity.addAssign(gravity.mul(dt));
      position.addAssign(velocity.mul(dt));
      position.assign(clamp(position, vec3(1), vec3(gx - 1, gy - 1, gz - 1)));
      // Keep the particle inside the wall as the example keeps it in its rounded box: push the
      // velocity by the predicted position's distance outside (cells per second per cell).
      const next = position.add(velocity.mul(dt).mul(2.0)).toConst("posNext");
      velocity.addAssign(intoTank(next).sub(next).mul(1.3));
      position.assign(intoTank(position));
      P.element(instanceIndex).get("position").assign(position);
      P.element(instanceIndex).get("velocity").assign(velocity);
    })()
      .compute(nMax, [WORKGROUP, 1, 1])
      .setName("fluidG2P");

    // Smoothed density (1-2-1 per axis) over rest density into the 3D texture.
    const density = (Fn as N)(() => {
      const x = int(instanceIndex).div(int(gz * gy));
      const y = int(instanceIndex).div(int(gz)).mod(int(gy));
      const z = int(instanceIndex).mod(int(gz));
      const sum = float(0).toVar("sum");
      Loop({ start: -1, end: 2, type: "int", name: "dx", condition: "<" }, ({ dx }: N) => {
        Loop({ start: -1, end: 2, type: "int", name: "dy", condition: "<" }, ({ dy }: N) => {
          Loop({ start: -1, end: 2, type: "int", name: "dz", condition: "<" }, ({ dz }: N) => {
            const c = clamp(ivec3(x.add(dx), y.add(dy), z.add(dz)), ivec3(0), ivec3(gx - 1, gy - 1, gz - 1));
            const wgt = float(2).sub(float(dx).abs()).mul(float(2).sub(float(dy).abs())).mul(float(2).sub(float(dz).abs()));
            sum.addAssign(cellsF.element(ptr(c)).w.mul(wgt));
          });
        });
      });
      textureStore(tex, uvec3(x, y, z), vec4(sum.div(64).div(restDensity), 0, 0, 1)).toWriteOnly();
    })()
      .compute(cellCount)
      .setName("fluidDensity");

    this.kernels = { clear, p2g1, p2g2, update, g2p, density };
  }

  /** Debug: the particles as small spheres (tank frame). */
  debugPoints(): THREE.Mesh {
    const g = this.grid;
    const mat = new THREE.MeshBasicNodeMaterial({ color: "#ff3355" });
    const P: N = this.particles;
    const { attribute, instanceIndex: ii, vec3: v3 } = TSL as N;
    mat.positionNode = attribute("position").add(P.element(ii).get("position").mul(g.h).add(v3(...g.origin)));
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(g.h * 0.25, 0), mat);
    (m as N).count = g.maxParticles;
    m.frustumCulled = false;
    return m;
  }

  /** Active particles (the liquid left). */
  get active(): number {
    return this.activeN;
  }

  get steps(): number {
    return this.stepCount;
  }

  /** The fill fraction the active particles stand for. */
  get fill(): number {
    return fillOf(this.grid, this.activeN);
  }

  /** Drains (or refills, without moving particles) to a fill fraction. */
  setFill(fill: number): void {
    this.activeN = activeCount(this.grid, fill);
    this.u.active.value = this.activeN;
  }

  /** Apparent gravity from the body-frame specific force (m/s²): the liquid settles along its opposite. */
  setSpecificForce(f: readonly number[]): void {
    const s = this.gScale / G0;
    (this.u.gravity.value as THREE.Vector3).set(-(f[0] ?? 0) * s, -(f[1] ?? 0) * s, -(f[2] ?? 0) * s);
  }

  /** Seek: the settled liquid for `fill` under the specific force `f`, at rest. */
  seed(fill: number, f: readonly number[], seed = 1): void {
    const { positions } = seedSettled(this.grid, this.shape, this.grid.maxParticles > 0 ? Math.max(fill, 0) : 0, [-(f[0] ?? 0), -(f[1] ?? 0), -(f[2] ?? 0)] as Vec3, seed);
    const attr = this.particles.value as THREE.StorageInstancedBufferAttribute;
    const arr = attr.array as Float32Array;
    arr.fill(0);
    for (let i = 0; i < this.grid.maxParticles; i++) {
      arr[i * PARTICLE_STRIDE] = positions[i * 3]!;
      arr[i * PARTICLE_STRIDE + 1] = positions[i * 3 + 1]!;
      arr[i * PARTICLE_STRIDE + 2] = positions[i * 3 + 2]!;
    }
    attr.needsUpdate = true;
    this.setFill(fill);
    this.setSpecificForce(f);
  }

  /** Advances `dt` seconds (split into substeps) and refreshes the density texture. */
  step(renderer: THREE.WebGPURenderer, dt: number): void {
    const h = Math.min(Math.max(dt, 1e-4), 1 / 60) / this.substeps;
    this.u.dt.value = h;
    this.dampU.value = Math.exp(-this.dampRate * h);
    const k = this.kernels;
    for (let i = 0; i < this.substeps; i++) {
      renderer.compute(k.clear);
      if (this.activeN > 0) {
        renderer.compute(k.p2g1);
        renderer.compute(k.p2g2);
      }
      renderer.compute(k.update);
      if (this.activeN > 0) renderer.compute(k.g2p);
    }
    renderer.compute(k.density);
    this.stepCount++;
  }

  /** GPU readback of the particle buffer (positions at `i * PARTICLE_STRIDE`, grid units). */
  async readParticles(renderer: THREE.WebGPURenderer): Promise<Float32Array> {
    const buf = await renderer.getArrayBufferAsync(this.particles.value as THREE.StorageInstancedBufferAttribute);
    return new Float32Array(buf);
  }

  /** Axial half extent of the tank in grid units. */
  get axialHalfCells(): number {
    return axialHalf(this.shape) / this.grid.h;
  }

  dispose(): void {
    this.densityTexture.dispose();
  }
}
