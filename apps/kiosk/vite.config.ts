import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The kiosk is deliberately plain: React and nothing else.
 *
 * No Tailwind, no component library, no router. A kiosk has six screens and
 * has to start quickly on a cheap Android phone at a gate, so every kilobyte
 * of framework is a kilobyte the guard waits for. The styling is one
 * hand-written stylesheet, `src/kiosk.css`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    // Not 5173: the dashboard already owns that, and both run at once.
    port: 5174,
    strictPort: true,
    // The kiosk talks to `/api/v1` on its own origin, in development as in
    // production. Same-origin is not a convenience: the deployed app's content
    // security policy sets `connect-src 'self'`, and a WebAuthn key is bound to
    // an origin, so a cross-origin API would break the fingerprint path. Point
    // this elsewhere with VITE_API_BASE_URL only when you mean to.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
