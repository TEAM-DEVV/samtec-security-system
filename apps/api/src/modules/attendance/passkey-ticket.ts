import { deriveKey, openSecret, sealSecret } from '../identity/secret-box.js';

/**
 * The sealed note a kiosk carries between the two halves of a WebAuthn
 * exchange (docs/plan/13-biometrics-design.md section 4).
 *
 * WebAuthn needs the server to remember the challenge it issued, and to know
 * that the answer coming back belongs to the question it asked. Rather than
 * keep a table of half-finished registrations — rows to write, expire and
 * clean up — the server hands the kiosk a note it cannot read or change, and
 * the kiosk hands it straight back. Nothing is stored until a key really
 * exists.
 *
 * The note says who it is about, which device asked, what was asked for, the
 * challenge, and when it stops being valid. It is sealed with AES-256-GCM
 * under a key of its own, so a kiosk can neither read a challenge meant for
 * another worker nor keep one alive past its two minutes.
 */

/** How long a kiosk has to come back with the device's answer. */
export const TICKET_GOOD_FOR_SECONDS = 120;

/**
 * What a ticket is for. Only a registration needs one: a clock-in's challenge
 * rides on the attempt row instead, which both halves of a clock-in already
 * share. It is still sealed in and checked, so the day a second kind of
 * ticket exists, one can never be spent as the other.
 */
export type TicketPurpose = 'REGISTER';

export interface PasskeyTicket {
  purpose: TicketPurpose;
  companyId: string;
  employeeId: string;
  deviceId: string;
  challenge: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/** The ticket key, from the one master secret the project keeps. */
export function passkeyTicketKey(authSecret: string): Buffer {
  return deriveKey(authSecret, 'passkey-ticket');
}

/** Seals a ticket for the kiosk to hand back. */
export function sealTicket(
  ticket: Omit<PasskeyTicket, 'expiresAt'>,
  key: Buffer,
  now: number = Date.now(),
): string {
  const withExpiry: PasskeyTicket = {
    ...ticket,
    expiresAt: now + TICKET_GOOD_FOR_SECONDS * 1000,
  };
  return sealSecret(JSON.stringify(withExpiry), key);
}

/**
 * Opens a ticket, or answers `null` when it cannot be trusted: sealed with
 * another key, changed on the way, past its two minutes, or asking about a
 * different worker, device or purpose than the request it arrived with.
 *
 * Every one of those is the same answer, because the kiosk has no business
 * knowing which it was.
 */
export function openTicket(
  sealed: string,
  key: Buffer,
  must: { purpose: TicketPurpose; companyId: string; deviceId: string; employeeId?: string },
  now: number = Date.now(),
): PasskeyTicket | null {
  const opened = openSecret(sealed, key);
  if (opened === null) {
    return null;
  }
  const ticket = parse(opened);
  if (
    !ticket ||
    ticket.purpose !== must.purpose ||
    ticket.companyId !== must.companyId ||
    ticket.deviceId !== must.deviceId ||
    (must.employeeId !== undefined && ticket.employeeId !== must.employeeId) ||
    ticket.expiresAt <= now
  ) {
    return null;
  }
  return ticket;
}

function parse(text: string): PasskeyTicket | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const ticket = value as Partial<PasskeyTicket>;
    const complete =
      ticket.purpose === 'REGISTER' &&
      typeof ticket.companyId === 'string' &&
      typeof ticket.employeeId === 'string' &&
      typeof ticket.deviceId === 'string' &&
      typeof ticket.challenge === 'string' &&
      typeof ticket.expiresAt === 'number';
    return complete ? (ticket as PasskeyTicket) : null;
  } catch {
    // Anything that is not the JSON this server wrote is simply not a ticket.
    return null;
  }
}
