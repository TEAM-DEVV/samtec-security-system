import { randomBytes } from 'node:crypto';

/**
 * A new UUID version 7: the time it was made, then random bits (RFC 9562).
 *
 * Every table in this project uses version 7 (`@default(uuid(7))`), because
 * ids made later sort after ids made earlier, which keeps pages and indexes
 * in a sensible order. Prisma fills them in by itself; this is for the rare
 * row whose id must be known **before** it is written — a face template is
 * sealed to its own row id, so the id has to exist first.
 *
 * Layout: 48 bits of milliseconds since 1970, 4 bits saying "version 7",
 * 12 random bits, 2 bits saying "this is a UUID", and 62 more random bits.
 */
export function newUuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(now);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((milliseconds >> BigInt(8 * (5 - index))) & 0xffn);
  }
  // Version 7 in the top half of byte 6, and the UUID variant in byte 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
