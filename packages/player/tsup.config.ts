import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
  },
  {
    // one file to drop in a page with a script tag, exposing window.MTV
    entry: { 'mtv-player': 'src/index.ts' },
    format: ['iife'],
    globalName: 'MTV',
    noExternal: [/@caixax\/.*/],
    minify: true,
    sourcemap: true,
    target: 'es2022',
  },
]);
