/**
 * Turns "somebody else got there first" into the answer the contract promises.
 *
 * Every create in this module checks for a clash and then writes, which is two
 * steps: between them, another request can write the same row. The reading
 * check is still worth having, because it produces a clear message in the
 * ordinary case — but on its own it turns a race into a `PrismaClientKnownRequestError`
 * with code `P2002`, which is not an HTTP exception, so `ProblemDetailsFilter`
 * has nothing to work with and answers 500. The contract says 409.
 *
 * The unique index is the real guard; this is what lets the loser of the race
 * be told so politely.
 */
import { ConflictException } from '@nestjs/common';

/** Prisma's code for "a unique constraint would have been broken". */
const UNIQUE_CONSTRAINT = 'P2002';

function isDuplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_CONSTRAINT
  );
}

/**
 * Runs a create, and reports a duplicate as a 409 with `message` rather than
 * letting it escape as a 500. Anything else is left alone: an error nobody
 * predicted should still reach the logs as itself.
 */
export async function orConflict<Result>(
  write: () => Promise<Result>,
  message: string,
): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicate(error)) {
      throw new ConflictException(message);
    }
    throw error;
  }
}
