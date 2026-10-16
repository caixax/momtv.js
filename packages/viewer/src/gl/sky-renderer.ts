/**
 * Draws the sky behind everything else.
 *
 * The six images sit on a cube around the camera and move with it, so the sky
 * never comes closer. It is drawn first, without touching the depth buffer,
 * and the map paints over whatever it covers.
 */
import type { Sky } from '../sky.js';
import { mat4LookAtZUp, mat4Multiply, mat4Perspective } from './math.js';
import type { RenderCamera } from './map-renderer.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec2 aUv;
uniform mat4 uViewProjection;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTexture, vUv).rgb, 1.0);
}`;

/** How far from the camera the cube sits; anything inside it hides it. */
const RADIUS = 1024;

interface SkyFaceBatch {
  vao: WebGLVertexArrayObject;
  texture: WebGLTexture;
}

/** Uploads a map's sky and draws it. */
export class SkyRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: {
    viewProjection: WebGLUniformLocation;
    texture: WebGLUniformLocation;
  };
  private faces: SkyFaceBatch[] = [];
  private buffers: WebGLBuffer[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    const need = (name: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(this.program, name);
      if (!loc) throw new Error(`uniform ${name} missing`);
      return loc;
    };
    this.uniforms = { viewProjection: need('uViewProjection'), texture: need('uTexture') };
  }

  /** True once a sky has been uploaded. */
  get hasSky(): boolean {
    return this.faces.length > 0;
  }

  /** Uploads the six images. A side with no image is left out. */
  upload(sky: Sky | undefined): void {
    const gl = this.gl;
    this.dispose();
    if (!sky) return;

    for (const face of sky.faces) {
      if (!face.texture) continue;
      const texture = gl.createTexture();
      if (!texture) continue;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        face.texture.width,
        face.texture.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        face.texture.pixels,
      );
      // The seams between the images must not sample each other's edges.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      // the quad of this side, as four corners of the cube
      const positions = new Float32Array(4 * 3);
      const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
      const corners: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      corners.forEach(([s, t], i) => {
        for (let axis = 0; axis < 3; axis++) {
          positions[i * 3 + axis] =
            (face.normal[axis]! +
              face.right[axis]! * (2 * s - 1) +
              face.up[axis]! * (1 - 2 * t)) *
            RADIUS;
        }
      });

      const vao = gl.createVertexArray();
      if (!vao) continue;
      gl.bindVertexArray(vao);
      this.attribute(0, positions, 3);
      this.attribute(1, uvs, 2);
      const ibo = gl.createBuffer();
      if (!ibo) continue;
      this.buffers.push(ibo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.faces.push({ vao, texture });
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private attribute(location: number, data: Float32Array, size: number): void {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) return;
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }

  /** Draws the sky. Call it before the map, which then paints over it. */
  render(camera: RenderCamera): void {
    if (this.faces.length === 0) return;
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const projection = mat4Perspective(
      ((camera.fovYDegrees ?? 75) * Math.PI) / 180,
      canvas.width / Math.max(1, canvas.height),
      1,
      RADIUS * 4,
    );
    // the cube follows the camera, so the sky stays where it is
    const view = mat4LookAtZUp([0, 0, 0], camera.pitch, camera.yaw);
    const viewProjection = mat4Multiply(projection, view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjection);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    for (const face of this.faces) {
      gl.bindTexture(gl.TEXTURE_2D, face.texture);
      gl.bindVertexArray(face.vao);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Frees GPU resources. */
  dispose(): void {
    for (const face of this.faces) {
      this.gl.deleteVertexArray(face.vao);
      this.gl.deleteTexture(face.texture);
    }
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    this.faces = [];
    this.buffers = [];
  }
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
