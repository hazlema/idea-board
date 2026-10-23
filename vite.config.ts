import { fileURLToPath } from 'node:url';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

const BOARD_SERVER = 'http://127.0.0.1:4777';

// The board server rejects requests whose Origin is not its own, so the dev
// proxy drops the header the browser adds for the Vite dev origin.
const proxy: ProxyOptions = {
  target: BOARD_SERVER,
  changeOrigin: true,
  configure: (p) => p.on('proxyReq', (r) => r.removeHeader('origin')),
};

export default defineConfig({
  root: 'web',
  plugins: [svelte({ configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)) }), tailwindcss(), svelteTesting()],
  resolve: { alias: { $lib: fileURLToPath(new URL('./web/src/lib', import.meta.url)) } },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // The server answers /assets/ with stored pictures, so the bundle lives elsewhere.
    assetsDir: 'static',
  },
  server: { proxy: { '/api': proxy, '/assets': proxy, '/mcp': proxy } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
});
