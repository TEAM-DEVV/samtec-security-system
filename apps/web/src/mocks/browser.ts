import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** The mock API inside the browser. `main.tsx` starts it in mock mode. */
export const worker = setupWorker(...handlers);
