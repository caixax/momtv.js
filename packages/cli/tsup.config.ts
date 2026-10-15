import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/mtv-dump.ts'],
  format: ['esm'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
