import { fileURLToPath } from 'node:url';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { BOARD_SERVER, proxiedOrigin } from './web/devProxy';

// The board server rejects requests whose Origin is not its own: the dev page's
// requests are passed on with the board server's origin, any other site's as they are.
const proxy: ProxyOptions = {
  target: BOARD_SERVER,
  changeOrigin: true,
  configure: (p) =>
    p.on('proxyReq', (proxyReq, req) => {
      const origin = proxiedOrigin(req.headers.origin, req.headers.host);
      if (origin) proxyReq.setHeader('origin', origin);
    }),
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
