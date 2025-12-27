import { defineConfig } from 'tsup';

// Build configuration for tuck CLI
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
