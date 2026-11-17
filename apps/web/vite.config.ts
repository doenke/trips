import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// x.yy.zzz from CI (scripts/version.mjs), "dev" for local builds.
const version = process.env.APP_VERSION || 'dev';
const backend = process.env.BACKEND_URL ?? 'http://localhost:41873';

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Writes the version and the app shell file list into the service worker after the build. */
function stampServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'trips-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const files = listFiles(outDir)
        .map((f) => `/${relative(outDir, f).split('\\').join('/')}`)
        .filter((f) => f !== '/sw.js' && f !== '/robots.txt' && !f.endsWith('.map') && !f.startsWith('/icon-512') && !f.includes('maskable'));
      const sw = readFileSync(swPath, 'utf8').replace('__VERSION__', version).replace('/*__FILES__*/', files.map((f) => JSON.stringify(f)).join(', '));
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [svelte(), stampServiceWorker()],
  build: { target: 'es2022', sourcemap: false },
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/auth', '/oauth', '/mcp', '/ics', '/avatar', '/healthz', '/.well-known'].map((p) => [p, { target: backend, changeOrigin: false }])),
  },
});
