/**
 * The one way an email is stored and compared: trimmed and lower-case. Sign-in
 * and account management both use it, and a database CHECK refuses anything
 * else, so "Ama@X" and "ama@x" can never be two different accounts.
 */
export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}
