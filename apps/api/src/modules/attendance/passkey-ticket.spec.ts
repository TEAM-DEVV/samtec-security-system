import { describe, expect, it } from 'vitest';
import {
  openTicket,
  passkeyTicketKey,
  sealTicket,
  TICKET_GOOD_FOR_SECONDS,
} from './passkey-ticket.js';

const key = passkeyTicketKey('a-test-secret-that-is-long-enough-to-use');
const other = passkeyTicketKey('a-different-secret-of-the-same-length!!!');

const ticket = {
  purpose: 'REGISTER' as const,
  companyId: '11111111-1111-7111-8111-111111111111',
  employeeId: '22222222-2222-7222-8222-222222222222',
  deviceId: '33333333-3333-7333-8333-333333333333',
  challenge: 'a-random-challenge',
};
const must = {
  purpose: 'REGISTER' as const,
  companyId: ticket.companyId,
  deviceId: ticket.deviceId,
  employeeId: ticket.employeeId,
};

describe('a passkey ticket', () => {
  it('comes back exactly as it went in', () => {
    const sealed = sealTicket(ticket, key);

    const opened = openTicket(sealed, key, must);

    expect(opened?.challenge).toBe('a-random-challenge');
    expect(opened?.employeeId).toBe(ticket.employeeId);
  });

  it('says nothing to a kiosk that tries to read or change it', () => {
    const sealed = sealTicket(ticket, key);

    // Sealed with another secret, or tampered with on the way.
    expect(openTicket(sealed, other, must)).toBeNull();
    const flipped = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
    expect(openTicket(flipped, key, must)).toBeNull();
    expect(openTicket('not-a-ticket-at-all', key, must)).toBeNull();
  });

  it('stops being valid after two minutes', () => {
    const now = Date.now();
    const sealed = sealTicket(ticket, key, now);

    expect(openTicket(sealed, key, must, now + TICKET_GOOD_FOR_SECONDS * 1000 - 1)).not.toBeNull();
    expect(openTicket(sealed, key, must, now + TICKET_GOOD_FOR_SECONDS * 1000)).toBeNull();
  });

  it('is no use for another worker, another device or another purpose', () => {
    const sealed = sealTicket(ticket, key);
    const somebodyElse = '44444444-4444-7444-8444-444444444444';

    expect(openTicket(sealed, key, { ...must, employeeId: somebodyElse })).toBeNull();
    expect(openTicket(sealed, key, { ...must, deviceId: somebodyElse })).toBeNull();
    expect(openTicket(sealed, key, { ...must, companyId: somebodyElse })).toBeNull();
    expect(openTicket(sealed, key, { ...must, purpose: 'AUTHENTICATE' })).toBeNull();
  });
});
