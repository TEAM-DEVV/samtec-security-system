import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { clearSession } from '@/lib/session';
import { resetMockSession } from '@/mocks/handlers/auth';
import { resetMockEmployees } from '@/mocks/handlers/employees';
import { server } from '@/mocks/node';

// Every test talks to the mock API. A request with no mock handler fails the
// test, so no test can quietly depend on a real backend.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  // Undo `server.use(...)` overrides and sign-ins on both sides (the mock API
  // and the dashboard's own session), so tests never affect each other.
  server.resetHandlers();
  resetMockSession();
  resetMockEmployees();
  clearSession();
  cleanup();
});

afterAll(() => server.close());
