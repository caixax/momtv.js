/**
 * Reader for VMT material definitions.
 *
 * A VMT is a keyvalues block whose outermost key is the shader name. What a
 * renderer needs from it is which texture to sample and how to treat the
 * texture's alpha: foliage and grates are cut out with an alpha test, glass
 * and water blend, and tool materials are not drawn at all.
 */

/** What a material definition says about how to draw a surface. */
export interface Vmt {
  /** Shader the material asks for, lowercase, for example `lightmappedgeneric`. */
  shader: string;
  /** Texture to sample, as a path under `materials/` without its extension. */
  baseTexture?: string;
  /** Material this one patches, for the `patch` shader. */
  include?: string;
  /** Alpha below the reference is cut away rather than blended. */
  alphaTest: boolean;
  /** Threshold for the alpha test, the engine's default when unstated. */
  alphaTestReference: number;
  /** The surface blends with what is behind it. */
  translucent: boolean;
  /** Constant opacity applied on top of the texture's own alpha. */
  alpha: number;
  /** Both sides of the surface are drawn. */
  noCull: boolean;
  /**
   * The surface exists for the compiler or the game logic and is invisible in
   * play: triggers, clips, areaportals, nodraw.
   */
  invisible: boolean;
}

/** Default threshold the engine uses when a material only says `$alphatest 1`. */
const DEFAULT_ALPHA_TEST = 0.5;

/** Shaders that never put anything on screen. */
const INVISIBLE_SHADERS = new Set(['hidden']);

/**
 * Flags a compiled material carries when the brush is a tool brush. Any of
 * them means the surface is not part of what a player sees.
 */
const INVISIBLE_FLAGS = [
  '%compilenodraw',
  '%compileclip',
  '%compileplayerclip',
  '%compiletrigger',
  '%compileinvisible',
  '%compilehint',
  '%compileskip',
  '%compileareaportal',
  '%compileladder',
  '$no_draw',
];

/** Reads one key's value, as written or quoted, case insensitively. */
function value(text: string, key: string): string | undefined {
  const escaped = key.replace(/[$%]/g, '\\$&');
  // The key ends at a quote or at whitespace, so `$alphatest` does not match
  // `$alphatestreference`. A quoted value runs to the closing quote and may
  // contain spaces, which map texture paths often do; an unquoted one ends at
  // whitespace or a brace.
  const match = new RegExp(
    `(?:^|[\\s"{])${escaped}(?:"\\s*|\\s+)(?:"([^"\r\n]*)"|([^"\\s}]+))`,
    'i',
  ).exec(text);
  if (!match) return undefined;
  return (match[1] ?? match[2])?.trim();
}

/** True when a key is present and not switched off. */
function flag(text: string, key: string): boolean {
  const raw = value(text, key);
  if (raw === undefined) return false;
  return raw !== '0';
}

function number(text: string, key: string, fallback: number): number {
  const raw = value(text, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Normalises a material or texture path the way the engine looks it up. */
function normalisePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^materials\//i, '')
    .replace(/\.(vmt|vtf)$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Parses a material definition.
 *
 * Unknown keys are ignored, and a definition this cannot make sense of still
 * returns something usable, since a map renders better with a wrong looking
 * surface than with a hole.
 */
export function parseVmt(text: string): Vmt {
  // Strip comments so a commented out key does not count.
  const body = text.replace(/\/\/[^\r\n]*/g, '');
  const shaderMatch = /^\s*"?([A-Za-z_][\w]*)"?\s*\{/.exec(body);
  const shader = (shaderMatch?.[1] ?? '').toLowerCase();

  const base = value(body, '$basetexture');
  const include = value(body, 'include');
  const alphaTestReference = number(body, '$alphatestreference', DEFAULT_ALPHA_TEST);
  const alpha = number(body, '$alpha', 1);

  const vmt: Vmt = {
    shader,
    alphaTest: flag(body, '$alphatest'),
    alphaTestReference,
    translucent: flag(body, '$translucent') || alpha < 1,
    alpha,
    noCull: flag(body, '$nocull'),
    invisible: INVISIBLE_SHADERS.has(shader) || INVISIBLE_FLAGS.some((key) => flag(body, key)),
  };
  if (base) vmt.baseTexture = normalisePath(base);
  if (include) vmt.include = normalisePath(include);
  return vmt;
}

/**
 * Folds a patch material into the material it includes.
 *
 * A `patch` only overrides a few keys, so the included definition supplies the
 * rest.
 */
export function applyPatch(patch: Vmt, included: Vmt): Vmt {
  const merged: Vmt = {
    ...included,
    // The patch's own switches win where it sets them.
    alphaTest: patch.alphaTest || included.alphaTest,
    translucent: patch.translucent || included.translucent,
    noCull: patch.noCull || included.noCull,
    invisible: patch.invisible || included.invisible,
    alpha: patch.alpha < 1 ? patch.alpha : included.alpha,
    alphaTestReference:
      patch.alphaTestReference !== DEFAULT_ALPHA_TEST
        ? patch.alphaTestReference
        : included.alphaTestReference,
  };
  if (patch.baseTexture) merged.baseTexture = patch.baseTexture;
  return merged;
}

/** A material name that is a tool brush, which the game never draws. */
export function isToolMaterial(name: string): boolean {
  return (
    /^tools\//i.test(name) || /(^|\/)toolstrigger|toolsnodraw|toolsclip|toolsskybox/i.test(name)
  );
}
