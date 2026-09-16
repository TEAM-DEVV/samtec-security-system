import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetMockSession } from '@/mocks/handlers/auth';
import { server } from '@/mocks/node';

// Every test talks to the mock API. A request with no mock handler fails the
// test, so no test can quietly depend on a real backend.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  // Undo `server.use(...)` overrides and mock sign-ins, so tests never affect each other.
  server.resetHandlers();
  resetMockSession();
  cleanup();
});

afterAll(() => server.close());
