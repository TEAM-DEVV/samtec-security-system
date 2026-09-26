import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    // The same zone the dashboard's tests use, so a date bug cannot hide
    // behind the computer's own zone being Ghana's.
    env: { TZ: 'Pacific/Honolulu' },
  },
});
