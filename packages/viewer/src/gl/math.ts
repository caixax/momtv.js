/** Minimal column-major mat4 helpers for the renderer (no dependencies). */

export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Perspective projection (right handed, depth -1..1). */
export function mat4Perspective(
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** Look-at view matrix for a Z-up world (Source engine coordinates). */
export function mat4LookAtZUp(
  eye: readonly [number, number, number],
  pitchDeg: number,
  yawDeg: number,
): Mat4 {
  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  // Source: +pitch looks down, yaw rotates counterclockwise from +X
  const fx = Math.cos(p) * Math.cos(y);
  const fy = Math.cos(p) * Math.sin(y);
  const fz = -Math.sin(p);
  // right = forward x worldUp
  let rx = fy * 1 - fz * 0;
  let ry = fz * 0 - fx * 1;
  let rz = fx * 0 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up = right x forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const m = new Float32Array(16);
  m[0] = rx;
  m[4] = ry;
  m[8] = rz;
  m[1] = ux;
  m[5] = uy;
  m[9] = uz;
  m[2] = -fx;
  m[6] = -fy;
  m[10] = -fz;
  m[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  m[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! +
        a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! +
        a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * Placement of a brush entity: its angles then its origin, in the order and
 * with the axes the engine uses (yaw about Z, pitch about Y, roll about X).
 */
export function mat4FromAngles(
  angles: readonly [number, number, number],
  origin: readonly [number, number, number],
): Mat4 {
  const [pitch, yaw, roll] = angles;
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  const r = (roll * Math.PI) / 180;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sy = Math.sin(y);
  const cy = Math.cos(y);
  const sr = Math.sin(r);
  const cr = Math.cos(r);
  const m = new Float32Array(16);
  // columns: the engine's forward, left and up vectors
  m[0] = cp * cy;
  m[1] = cp * sy;
  m[2] = -sp;
  m[4] = sr * sp * cy - cr * sy;
  m[5] = sr * sp * sy + cr * cy;
  m[6] = sr * cp;
  m[8] = cr * sp * cy + sr * sy;
  m[9] = cr * sp * sy - sr * cy;
  m[10] = cr * cp;
  m[12] = origin[0];
  m[13] = origin[1];
  m[14] = origin[2];
  m[15] = 1;
  return m;
}
