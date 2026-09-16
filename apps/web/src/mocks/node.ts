import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/** The same mock API for tests, which run in Node.js instead of a browser. */
export const server = setupServer(...handlers);
