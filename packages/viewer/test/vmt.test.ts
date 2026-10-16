import { describe, expect, it } from 'vitest';
import { applyPatch, isToolMaterial, parseVmt } from '../src/bsp/vmt.js';

describe('parseVmt', () => {
  it('reads the shader and the base texture', () => {
    const vmt = parseVmt('"LightmappedGeneric"\n{\n\t"$basetexture" "brick/brickwall 001a"\n}');
    expect(vmt.shader).toBe('lightmappedgeneric');
    expect(vmt.baseTexture).toBe('brick/brickwall 001a');
  });

  it('reads an unquoted definition and normalises the path', () => {
    const vmt = parseVmt('LightmappedGeneric { $BaseTexture materials\\Nature\\Rock01.vtf }');
    expect(vmt.baseTexture).toBe('nature/rock01');
  });

  it('reads the alpha test and its threshold', () => {
    const vmt = parseVmt(
      'LightmappedGeneric\n{\n\t$basetexture "gsrcconv/{x_tree13a"\n\t$alphatest 1\n\t$alphatestreference 0.3\n}',
    );
    expect(vmt.alphaTest).toBe(true);
    expect(vmt.alphaTestReference).toBeCloseTo(0.3);
    expect(vmt.translucent).toBe(false);
  });

  it('does not read the threshold as the alpha test itself', () => {
    const vmt = parseVmt('LightmappedGeneric { $basetexture a/b $alphatestreference 0.4 }');
    expect(vmt.alphaTest).toBe(false);
    expect(vmt.alphaTestReference).toBeCloseTo(0.4);
  });

  it('treats a switched off key as absent', () => {
    expect(parseVmt('UnlitGeneric { $alphatest 0 }').alphaTest).toBe(false);
    expect(parseVmt('UnlitGeneric { "$translucent" "0" }').translucent).toBe(false);
  });

  it('reads blending, both from the flag and from a constant opacity', () => {
    expect(parseVmt('UnlitGeneric { $translucent 1 }').translucent).toBe(true);
    const faded = parseVmt('UnlitGeneric { $alpha 0.4 }');
    expect(faded.translucent).toBe(true);
    expect(faded.alpha).toBeCloseTo(0.4);
  });

  it('marks compiler and tool surfaces invisible', () => {
    expect(parseVmt('UnlitGeneric { %compiletrigger 1 }').invisible).toBe(true);
    expect(parseVmt('UnlitGeneric { %compilenodraw 1 }').invisible).toBe(true);
    expect(parseVmt('Hidden { }').invisible).toBe(true);
    expect(parseVmt('LightmappedGeneric { $basetexture a/b }').invisible).toBe(false);
  });

  it('ignores commented out keys', () => {
    const vmt = parseVmt('LightmappedGeneric {\n// $alphatest 1\n$basetexture a/b\n}');
    expect(vmt.alphaTest).toBe(false);
    expect(vmt.baseTexture).toBe('a/b');
  });

  it('reads what a patch includes', () => {
    const vmt = parseVmt('"patch"\n{\n\t"include" "materials/TILE/FLOOR_TILE_002A.vmt"\n}');
    expect(vmt.shader).toBe('patch');
    expect(vmt.include).toBe('tile/floor_tile_002a');
  });
});

describe('applyPatch', () => {
  it('takes the included material and keeps the patch overrides', () => {
    const included = parseVmt('LightmappedGeneric { $basetexture tile/floor $alphatest 1 }');
    const patch = parseVmt('patch { include materials/tile/floor.vmt $translucent 1 }');
    const merged = applyPatch(patch, included);
    expect(merged.baseTexture).toBe('tile/floor');
    expect(merged.alphaTest).toBe(true);
    expect(merged.translucent).toBe(true);
  });

  it('lets the patch replace the texture', () => {
    const included = parseVmt('LightmappedGeneric { $basetexture tile/floor }');
    const patch = parseVmt('patch { include materials/tile/floor.vmt $basetexture tile/other }');
    expect(applyPatch(patch, included).baseTexture).toBe('tile/other');
  });
});

describe('isToolMaterial', () => {
  it('recognises the brushes the game does not draw', () => {
    expect(isToolMaterial('tools/toolstrigger')).toBe(true);
    expect(isToolMaterial('TOOLS/ToolsNoDraw')).toBe(true);
    expect(isToolMaterial('tools/toolsskybox2d')).toBe(true);
    expect(isToolMaterial('brick/brickwall001a')).toBe(false);
    expect(isToolMaterial('metal/toolbox001')).toBe(false);
  });
});
