import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// The build id (finding 11): compiled into the bundle and written as /build.json, so an open tab can tell that the
// server now serves a newer build. Empty for the dev server (no check there).
const BUILD_ID = process.env.BUILD_ID || `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export default defineConfig(({ command }) => ({
  root: resolve(__dirname),
  define: { __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : '') },
  plugins: [svelte(), {
    name: 'build-id',
    apply: 'build',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ id: BUILD_ID }) + '\n' }); },
  }],
  build: { outDir: resolve(__dirname, '../dist/web'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8090', '/auth': 'http://localhost:8090' } },
}));
