import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // node:sqlite only exists with the prefix – keep "node:" on all built-in imports.
  removeNodeProtocol: false,
});
