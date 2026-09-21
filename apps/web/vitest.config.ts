import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      // Run the tests far from Ghana (Honolulu is UTC-10). A date shown in the
      // computer's own time zone, instead of UTC or Africa/Accra, then fails a test.
      env: { TZ: 'Pacific/Honolulu' },
      // Page tests type into forms, call the mock API and change route. On a
      // slow or busy machine that can pass Vitest's 5-second default.
      testTimeout: 15_000,
    },
  }),
);
