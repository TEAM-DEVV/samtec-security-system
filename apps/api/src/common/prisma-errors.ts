/**
 * True when the database rejected a write because a unique rule (Prisma error
 * P2002) covering the named column was broken — for example a second employee
 * with the same Ghana Card number, or a second account with the same email.
 */
export function isUniqueViolation(error: unknown, column: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; meta?: unknown };
  if (candidate.code !== 'P2002') {
    return false;
  }
  // Which columns broke the rule sits in the error's metadata; its exact
  // shape varies by driver, so search the whole thing for the column name.
  const normalize = (value: string) => value.toLowerCase().replaceAll('_', '');
  return normalize(JSON.stringify(candidate.meta ?? {})).includes(normalize(column));
}
