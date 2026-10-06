import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(__dirname),
  plugins: [svelte()],
  build: { outDir: resolve(__dirname, '../dist/web'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8090', '/auth': 'http://localhost:8090' } },
});
