/**
 * True when a database URL points at this computer. The seed, the demo
 * simulator and the admin rescue script use it to stay away from shared or
 * hosted databases unless someone asks for that on purpose.
 */
export function isOnThisComputer(databaseUrl: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname);
}
