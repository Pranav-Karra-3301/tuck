import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  target: 'node18',
  splitting: false,
});
