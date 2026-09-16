import { rmSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), keepMockApiOutOfBuilds()],
  resolve: {
    alias: {
      // Lets code import from '@/lib/api' instead of long '../../lib/api' paths.
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});

/**
 * The mock API is for development only. This plugin refuses to build the
 * dashboard in mock mode, and deletes MSW's service worker file (which Vite
 * copies from `public/`) from the finished build.
 */
function keepMockApiOutOfBuilds(): Plugin {
  let outDir = '';
  return {
    name: 'samtec:keep-mock-api-out-of-builds',
    apply: 'build',
    config(_config, { mode }) {
      if (mode === 'mock') {
        throw new Error(
          'The mock API is for development only. Build the dashboard without "--mode mock".',
        );
      }
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(path.join(outDir, 'mockServiceWorker.js'), { force: true });
    },
  };
}
