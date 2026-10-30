/**
 * Axis gizmo geometry (concept 01, top right of the viewport): the body axes
 * X (aft, red), Y (green), Z (up, blue) as seen by the camera. Pure: takes
 * the camera's world basis, returns 2D endpoints (x right, y down) inside a
 * square of `size` px.
 */
import { bodyToWorld, type Vec3 } from "./views.ts";

export interface GizmoAxis {
  axis: "X" | "Y" | "Z";
  color: string;
  /** Endpoint in px, centre at (size/2, size/2). */
  x: number;
  y: number;
  /** Toward the viewer (drawn on top) when > 0. */
  depth: number;
}

export const AXIS_COLORS = { X: "#e5484d", Y: "#46a758", Z: "#3e8ed0" } as const;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** `basis`: the camera's right, up, and back (toward the viewer) unit vectors in world space. */
export function gizmoAxes(basis: { right: Vec3; up: Vec3; back: Vec3 }, size = 64, length = 0.36): GizmoAxis[] {
  const c = size / 2;
  const L = size * length;
  const axes: [GizmoAxis["axis"], Vec3][] = [
    ["X", bodyToWorld([1, 0, 0])],
    ["Y", bodyToWorld([0, 1, 0])],
    ["Z", bodyToWorld([0, 0, 1])],
  ];
  return axes
    .map(([axis, v]) => ({
      axis,
      color: AXIS_COLORS[axis],
      x: c + dot(v, basis.right) * L,
      y: c - dot(v, basis.up) * L,
      depth: dot(v, basis.back),
    }))
    .sort((a, b) => a.depth - b.depth);
}
