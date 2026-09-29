import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no camera and no `play()`, and a screen that calls either would
// otherwise fail with an unrelated error rather than the assertion under test.
// The models test runs in plain Node, where there is no HTMLMediaElement at
// all — hence the first check.
if (typeof HTMLMediaElement !== 'undefined' && !('play' in HTMLMediaElement.prototype)) {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: () => Promise.resolve(),
  });
}

afterEach(cleanup);
