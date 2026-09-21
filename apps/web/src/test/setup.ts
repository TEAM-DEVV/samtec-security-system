import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetMockSession } from '@/mocks/handlers/auth';
import { resetMockEmployees } from '@/mocks/handlers/employees';
import { resetMockRosters } from '@/mocks/handlers/rosters';
import { server } from '@/mocks/node';

// Every test talks to the mock API. A request with no mock handler fails the
// test, so no test can quietly depend on a real backend.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  // Undo `server.use(...)` overrides and mock sign-ins, so tests never affect each other.
  server.resetHandlers();
  resetMockSession();
  resetMockEmployees();
  resetMockRosters();
  cleanup();
});

afterAll(() => server.close());
