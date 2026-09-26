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
  },
});
