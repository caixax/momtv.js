/**
 * WebGL2 renderer for a parsed BSP map.
 *
 * Current pipeline: flat material colors (texdata reflectivity) with
 * hemisphere shading. Textures (VTF from the pakfile and user-hosted assets)
 * and lightmaps are planned next.
 */
import type { BspMap } from '../bsp/bsp-file.js';
import { mat4LookAtZUp, mat4Multiply, mat4Perspective, type Mat4 } from './math.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProjection;
out vec3 vNormal;
out vec3 vColor;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  // hemisphere light: sky from +Z plus a soft directional for side definition
  float sky = 0.55 + 0.45 * clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
  float side = 0.12 * clamp(dot(n, normalize(vec3(0.4, 0.3, 0.86))), 0.0, 1.0);
  vec3 c = pow(vColor, vec3(0.4545)) * (sky + side);
  outColor = vec4(c, 1.0);
}`;

interface DrawBatch {
  vao: WebGLVertexArrayObject;
  indexCount: number;
}

/** Camera description for a render pass. */
export interface RenderCamera {
  position: readonly [number, number, number];
  pitch: number;
  yaw: number;
  fovYDegrees?: number;
}

/** Uploads a BSP map and renders it with a simple shaded pipeline. */
export class MapRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uViewProjection: WebGLUniformLocation;
  private batches: DrawBatch[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    const loc = gl.getUniformLocation(this.program, 'uViewProjection');
    if (!loc) throw new Error('uViewProjection uniform missing');
    this.uViewProjection = loc;
  }

  /** Uploads every model's geometry (world and brush entities). */
  upload(map: BspMap): void {
    const gl = this.gl;
    this.dispose();
    // brush entities keep their geometry in world coordinates in Momentum
    // maps, so all models are drawn at identity. Entity origins are ignored
    // until animated brushes are supported.
    for (const model of map.models) {
      for (const group of model.meshes) {
        const material = map.materials[group.materialIndex];
        const color = material ? material.reflectivity : [0.6, 0.6, 0.6];
        const vertexCount = group.positions.length / 3;
        const colors = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          colors[i * 3] = Math.min(1, Math.abs(color[0]!));
          colors[i * 3 + 1] = Math.min(1, Math.abs(color[1]!));
          colors[i * 3 + 2] = Math.min(1, Math.abs(color[2]!));
        }
        const vao = gl.createVertexArray();
        if (!vao) throw new Error('createVertexArray failed');
        gl.bindVertexArray(vao);
        uploadAttribute(gl, 0, group.positions, 3);
        uploadAttribute(gl, 1, group.normals, 3);
        uploadAttribute(gl, 2, colors, 3);
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, group.indices, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        this.batches.push({ vao, indexCount: group.indices.length });
      }
    }
  }

  /** Renders one frame. */
  render(camera: RenderCamera): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const width = canvas.width;
    const height = canvas.height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.35, 0.47, 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CW); // Source faces wind clockwise when viewed from outside

    const projection = mat4Perspective(
      ((camera.fovYDegrees ?? 75) * Math.PI) / 180,
      width / Math.max(1, height),
      4,
      65536,
    );
    const view = mat4LookAtZUp(camera.position, camera.pitch, camera.yaw);
    const viewProjection: Mat4 = mat4Multiply(projection, view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProjection, false, viewProjection);
    for (const batch of this.batches) {
      gl.bindVertexArray(batch.vao);
      gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  /** Frees GPU resources. */
  dispose(): void {
    for (const batch of this.batches) this.gl.deleteVertexArray(batch.vao);
    this.batches = [];
  }
}

function uploadAttribute(
  gl: WebGL2RenderingContext,
  location: number,
  data: Float32Array,
  size: number,
): void {
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? 'unknown'}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown'}`);
  }
  return program;
}
