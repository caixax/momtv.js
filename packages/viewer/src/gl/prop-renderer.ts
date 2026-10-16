/**
 * Draws the static props of a map.
 *
 * A map places the same model over and over, so each model is uploaded once
 * and drawn for all its placements in a single call, with the placement as a
 * per instance attribute. Props do not move, so the transforms are uploaded
 * once with the geometry.
 */
import type { PropModel } from '../props.js';
import { mat4LookAtZUp, mat4Multiply, mat4Perspective, type Mat4 } from './math.js';
import type { RenderCamera } from './map-renderer.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 aModel0;
layout(location=4) in vec4 aModel1;
layout(location=5) in vec4 aModel2;
layout(location=6) in vec4 aModel3;
uniform mat4 uViewProjection;
out vec3 vNormal;
out vec2 vUv;
void main() {
  mat4 model = mat4(aModel0, aModel1, aModel2, aModel3);
  vNormal = mat3(model) * aNormal;
  vUv = aUv;
  gl_Position = uViewProjection * model * vec4(aPosition, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec3 uColor;
uniform bool uHasTexture;
uniform float uAlphaRef;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec4 sampled = uHasTexture ? texture(uTexture, vUv) : vec4(pow(uColor, vec3(0.4545)), 1.0);
  if (sampled.a < uAlphaRef) discard;
  // Props carry no baked lighting here, so they take the same hemisphere
  // light the renderer uses for unlit surfaces.
  vec3 n = normalize(vNormal);
  float sky = 0.6 + 0.4 * clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
  float side = 0.12 * clamp(dot(n, normalize(vec3(0.4, 0.3, 0.86))), 0.0, 1.0);
  outColor = vec4(sampled.rgb * (sky + side), sampled.a * uAlpha);
}`;

interface PropBatch {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  instanceCount: number;
  texture: WebGLTexture | null;
  color: [number, number, number];
  alphaRef: number;
  alpha: number;
  translucent: boolean;
}

/** Uploads the props of a map and draws them. */
export class PropRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: {
    viewProjection: WebGLUniformLocation;
    texture: WebGLUniformLocation;
    color: WebGLUniformLocation;
    hasTexture: WebGLUniformLocation;
    alphaRef: WebGLUniformLocation;
    alpha: WebGLUniformLocation;
  };
  private batches: PropBatch[] = [];
  private textures: WebGLTexture[] = [];
  private buffers: WebGLBuffer[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    const need = (name: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(this.program, name);
      if (!loc) throw new Error(`uniform ${name} missing`);
      return loc;
    };
    this.uniforms = {
      viewProjection: need('uViewProjection'),
      texture: need('uTexture'),
      color: need('uColor'),
      hasTexture: need('uHasTexture'),
      alphaRef: need('uAlphaRef'),
      alpha: need('uAlpha'),
    };
  }

  /** How many props are on screen, as batches and as placements. */
  get stats(): { batches: number; instances: number } {
    let instances = 0;
    for (const batch of this.batches) instances += batch.instanceCount;
    return { batches: this.batches.length, instances };
  }

  /** Uploads every model and its placements. */
  upload(models: readonly PropModel[]): void {
    const gl = this.gl;
    this.dispose();
    const uploaded = new Map<object, WebGLTexture | null>();

    for (const model of models) {
      if (model.instances.length === 0) continue;
      // one buffer of placements, shared by every mesh of this model
      const instanceData = new Float32Array(model.instances.length * 16);
      model.instances.forEach((matrix, i) => instanceData.set(matrix, i * 16));
      const instanceBuffer = gl.createBuffer();
      if (!instanceBuffer) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);
      this.buffers.push(instanceBuffer);

      for (const mesh of model.meshes) {
        let texture = uploaded.get(mesh.material);
        if (texture === undefined) {
          texture = null;
          const decoded = mesh.material.texture;
          if (decoded) {
            const created = gl.createTexture();
            if (created) {
              gl.bindTexture(gl.TEXTURE_2D, created);
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                decoded.width,
                decoded.height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                decoded.pixels,
              );
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
              gl.generateMipmap(gl.TEXTURE_2D);
              this.textures.push(created);
              texture = created;
            }
          }
          uploaded.set(mesh.material, texture);
        }

        const vao = gl.createVertexArray();
        if (!vao) continue;
        gl.bindVertexArray(vao);
        this.attribute(0, mesh.positions, 3);
        this.attribute(1, mesh.normals, 3);
        this.attribute(2, mesh.uvs, 2);
        // the placement, one matrix per instance, as four columns
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        for (let c = 0; c < 4; c++) {
          const location = 3 + c;
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 64, c * 16);
          gl.vertexAttribDivisor(location, 1);
        }
        const ibo = gl.createBuffer();
        if (!ibo) continue;
        this.buffers.push(ibo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        this.batches.push({
          vao,
          indexCount: mesh.indices.length,
          instanceCount: model.instances.length,
          texture,
          color: mesh.material.color,
          alphaRef: mesh.material.alphaTest && texture ? mesh.material.alphaTestReference : -1,
          alpha: mesh.material.alpha,
          translucent: mesh.material.translucent && !mesh.material.alphaTest,
        });
      }
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

  /**
   * Draws the props. Call it after the map, with the same camera, so they sit
   * in the depth buffer the map has already written.
   */
  render(camera: RenderCamera): void {
    if (this.batches.length === 0) return;
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const projection = mat4Perspective(
      ((camera.fovYDegrees ?? 75) * Math.PI) / 180,
      canvas.width / Math.max(1, canvas.height),
      4,
      65536,
    );
    const view = mat4LookAtZUp(camera.position, camera.pitch, camera.yaw);
    const viewProjection: Mat4 = mat4Multiply(projection, view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjection);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);

    const draw = (batch: PropBatch): void => {
      gl.uniform3fv(this.uniforms.color, batch.color);
      gl.uniform1i(this.uniforms.hasTexture, batch.texture ? 1 : 0);
      gl.uniform1f(this.uniforms.alphaRef, batch.alphaRef);
      gl.uniform1f(this.uniforms.alpha, batch.alpha);
      if (batch.texture) gl.bindTexture(gl.TEXTURE_2D, batch.texture);
      gl.bindVertexArray(batch.vao);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        batch.indexCount,
        gl.UNSIGNED_INT,
        0,
        batch.instanceCount,
      );
    };

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const batch of this.batches) if (!batch.translucent) draw(batch);
    const blended = this.batches.filter((b) => b.translucent);
    if (blended.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const batch of blended) draw(batch);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  /** Frees GPU resources. */
  dispose(): void {
    for (const batch of this.batches) this.gl.deleteVertexArray(batch.vao);
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    this.batches = [];
    this.textures = [];
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
