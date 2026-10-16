/**
 * WebGL2 renderer for a parsed BSP map.
 *
 * Geometry is grouped by material; a material renders with its texture when
 * one was resolved, or with the flat colour from the map's texdata otherwise,
 * both shaded by a hemisphere light so surfaces read in three dimensions.
 *
 * A material also says how its alpha is meant to be treated. Foliage and
 * grates are cut out where the texture is transparent, glass and water blend
 * over what is behind them, and tool brushes (triggers, clips, nodraw) are not
 * drawn at all, since the game does not draw them either.
 */
import type { BspMap } from '../bsp/bsp-file.js';
import type { LoadedMaterial } from '../materials.js';
import { mat4LookAtZUp, mat4Multiply, mat4Perspective, type Mat4 } from './math.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec2 aLightmapUv;
uniform mat4 uViewProjection;
out vec3 vNormal;
out vec2 vUv;
out vec2 vLightmapUv;
void main() {
  vNormal = aNormal;
  vUv = aUv;
  vLightmapUv = aLightmapUv;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec2 vUv;
in vec2 vLightmapUv;
uniform sampler2D uTexture;
uniform sampler2D uLightmap;
uniform vec3 uColor;
uniform bool uHasTexture;
uniform bool uHasLightmap;
uniform vec2 uTexelScale;
uniform float uAlphaRef;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec4 sampled = uHasTexture
    ? texture(uTexture, vUv * uTexelScale)
    : vec4(pow(uColor, vec3(0.4545)), 1.0);
  // A negative reference means the material does not cut itself out.
  if (sampled.a < uAlphaRef) discard;
  vec3 light;
  if (uHasLightmap && vLightmapUv.x >= 0.0) {
    // baked lighting, lifted slightly so unlit corners stay readable
    light = texture(uLightmap, vLightmapUv).rgb * 1.8 + 0.08;
  } else {
    vec3 n = normalize(vNormal);
    float sky = 0.6 + 0.4 * clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
    float side = 0.12 * clamp(dot(n, normalize(vec3(0.4, 0.3, 0.86))), 0.0, 1.0);
    light = vec3(sky + side);
  }
  outColor = vec4(sampled.rgb * light, sampled.a * uAlpha);
}`;

interface DrawBatch {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  texture: WebGLTexture | null;
  color: [number, number, number];
  /** 1 / texture size, to turn texel space UVs into normalized ones. */
  texelScale: [number, number];
  /** Alpha below which a fragment is thrown away, or -1 to keep everything. */
  alphaRef: number;
  /** Constant opacity the material asks for. */
  alpha: number;
  /** Drawn in the blended pass, after everything opaque. */
  translucent: boolean;
  /** Mid point of the batch, to sort the blended pass by depth. */
  center: [number, number, number];
}

/** Camera description for a render pass. */
export interface RenderCamera {
  position: readonly [number, number, number];
  pitch: number;
  yaw: number;
  fovYDegrees?: number;
}

/** Uploads a BSP map and renders it. */
export class MapRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: {
    viewProjection: WebGLUniformLocation;
    texture: WebGLUniformLocation;
    lightmap: WebGLUniformLocation;
    color: WebGLUniformLocation;
    hasTexture: WebGLUniformLocation;
    hasLightmap: WebGLUniformLocation;
    texelScale: WebGLUniformLocation;
    alphaRef: WebGLUniformLocation;
    alpha: WebGLUniformLocation;
  };
  private batches: DrawBatch[] = [];
  private blended: DrawBatch[] = [];
  private textures: WebGLTexture[] = [];
  private lightmapTexture: WebGLTexture | null = null;

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
      lightmap: need('uLightmap'),
      color: need('uColor'),
      hasTexture: need('uHasTexture'),
      hasLightmap: need('uHasLightmap'),
      texelScale: need('uTexelScale'),
      alphaRef: need('uAlphaRef'),
      alpha: need('uAlpha'),
    };
  }

  /**
   * Uploads every model's geometry. Pass the resolved materials to render
   * with textures; without them every surface uses its flat colour.
   */
  upload(map: BspMap, materials?: LoadedMaterial[]): void {
    const gl = this.gl;
    this.dispose();

    // the baked lighting of the whole map lives in one atlas
    if (map.lightmap) {
      const texture = gl.createTexture();
      if (texture) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          map.lightmap.width,
          map.lightmap.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          map.lightmap.pixels,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.lightmapTexture = texture;
      }
    }

    // one GPU texture per material, shared by all batches using it
    const glTextures = new Map<number, { texture: WebGLTexture; width: number; height: number }>();
    if (materials) {
      for (let i = 0; i < materials.length; i++) {
        const decoded = materials[i]?.texture;
        if (!decoded) continue;
        const texture = gl.createTexture();
        if (!texture) continue;
        gl.bindTexture(gl.TEXTURE_2D, texture);
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
        this.textures.push(texture);
        glTextures.set(i, { texture, width: decoded.width, height: decoded.height });
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // brush entity geometry is already in world coordinates in Momentum maps,
    // so every model draws at identity
    for (const model of map.models) {
      for (const group of model.meshes) {
        const material = map.materials[group.materialIndex];
        const resolved = glTextures.get(group.materialIndex);
        const loaded = materials?.[group.materialIndex];
        if (loaded && !loaded.drawn) continue; // a tool brush, invisible in game
        const vao = gl.createVertexArray();
        if (!vao) throw new Error('createVertexArray failed');
        gl.bindVertexArray(vao);
        uploadAttribute(gl, 0, group.positions, 3);
        uploadAttribute(gl, 1, group.normals, 3);
        uploadAttribute(gl, 2, group.uvs, 2);
        uploadAttribute(gl, 3, group.lightmapUvs, 2);
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, group.indices, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        const batch: DrawBatch = {
          vao,
          indexCount: group.indices.length,
          texture: resolved?.texture ?? null,
          color:
            loaded?.color ??
            (material
              ? [
                  Math.min(1, Math.abs(material.reflectivity[0])),
                  Math.min(1, Math.abs(material.reflectivity[1])),
                  Math.min(1, Math.abs(material.reflectivity[2])),
                ]
              : [0.6, 0.6, 0.6]),
          texelScale: resolved ? [1 / resolved.width, 1 / resolved.height] : [1, 1],
          // Only cut a surface out when the material says so, and only when its
          // texture was resolved: a flat colour has no alpha to test.
          alphaRef: loaded?.alphaTest && resolved ? loaded.alphaTestReference : -1,
          alpha: loaded?.alpha ?? 1,
          translucent: (loaded?.translucent ?? false) && !loaded?.alphaTest,
          center: centerOf(group.positions),
        };
        (batch.translucent ? this.blended : this.batches).push(batch);
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
    // Brush faces are single sided in the file but the viewer is often inside
    // sealed geometry looking at it from either side (and displacements are
    // not built yet), so faces render double sided: a missing wall reads much
    // worse than a wall seen from behind.
    gl.disable(gl.CULL_FACE);

    const projection = mat4Perspective(
      ((camera.fovYDegrees ?? 75) * Math.PI) / 180,
      width / Math.max(1, height),
      4,
      65536,
    );
    const view = mat4LookAtZUp(camera.position, camera.pitch, camera.yaw);
    const viewProjection: Mat4 = mat4Multiply(projection, view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjection);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.uniform1i(this.uniforms.lightmap, 1);
    gl.uniform1i(this.uniforms.hasLightmap, this.lightmapTexture ? 1 : 0);
    if (this.lightmapTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lightmapTexture);
    }
    gl.activeTexture(gl.TEXTURE0);

    const draw = (batch: DrawBatch): void => {
      gl.uniform3fv(this.uniforms.color, batch.color);
      gl.uniform1i(this.uniforms.hasTexture, batch.texture ? 1 : 0);
      gl.uniform2fv(this.uniforms.texelScale, batch.texelScale);
      gl.uniform1f(this.uniforms.alphaRef, batch.alphaRef);
      gl.uniform1f(this.uniforms.alpha, batch.alpha);
      if (batch.texture) gl.bindTexture(gl.TEXTURE_2D, batch.texture);
      gl.bindVertexArray(batch.vao);
      gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0);
    };

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const batch of this.batches) draw(batch);

    if (this.blended.length > 0) {
      // Blended surfaces go last, farthest first, and do not write depth, so a
      // pane of glass does not hide what is behind it.
      const [cx, cy, cz] = camera.position;
      const order = [...this.blended].sort((a, b) => {
        const da =
          (a.center[0] - cx) ** 2 + (a.center[1] - cy) ** 2 + (a.center[2] - cz) ** 2;
        const db =
          (b.center[0] - cx) ** 2 + (b.center[1] - cy) ** 2 + (b.center[2] - cz) ** 2;
        return db - da;
      });
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const batch of order) draw(batch);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  /** Frees GPU resources. */
  dispose(): void {
    for (const batch of [...this.batches, ...this.blended]) {
      this.gl.deleteVertexArray(batch.vao);
    }
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    if (this.lightmapTexture) this.gl.deleteTexture(this.lightmapTexture);
    this.batches = [];
    this.blended = [];
    this.textures = [];
    this.lightmapTexture = null;
  }
}

/** Mid point of a batch's bounding box, for depth sorting. */
function centerOf(positions: Float32Array): [number, number, number] {
  if (positions.length === 0) return [0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
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
