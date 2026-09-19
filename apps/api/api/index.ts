import type { IncomingMessage, ServerResponse } from 'node:http';
// Compiled by `pnpm build` before Vercel bundles this function.
import { createApiHandler } from '../dist/serverless.js';

/**
 * Vercel's entry point for the whole API: every request to this deployment
 * lands here (see vercel.json) and is handed to the NestJS app.
 *
 * The app is built once per warm function instance and reused; only the very
 * first request after a cold start pays the startup cost.
 */
let handlerPromise: ReturnType<typeof createApiHandler> | undefined;

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  handlerPromise ??= createApiHandler();
  const app = await handlerPromise;
  app(request, response);
}
