import { describe, expect, it } from 'vitest';
import { kindMayUse, signatureMatches, signRequest, timestampIsFresh } from './device-signature.js';
import {
  judgePunchTime,
  mayClockIn,
  punchPayloadHash,
  staffNumberForDeviceUser,
} from './punch-rules.js';

describe('device signatures', () => {
  const secret = 'test-device-secret';
  const body = '{"punches":[]}';

  it('accepts exactly the signed request and nothing else', () => {
    const signature = signRequest(secret, '1790000000', 'ingest/punches', body);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signatureMatches(secret, '1790000000', 'ingest/punches', body, signature)).toBe(true);

    // One changed byte anywhere breaks it.
    expect(signatureMatches(secret, '1790000000', 'ingest/punches', `${body} `, signature)).toBe(
      false,
    );
    expect(signatureMatches(secret, '1790000001', 'ingest/punches', body, signature)).toBe(false);
    expect(signatureMatches('other-secret', '1790000000', 'ingest/punches', body, signature)).toBe(
      false,
    );
    // A heartbeat signature cannot be replayed against the punches endpoint.
    const heartbeat = signRequest(secret, '1790000000', 'ingest/heartbeat', body);
    expect(signatureMatches(secret, '1790000000', 'ingest/punches', body, heartbeat)).toBe(false);
    // Junk never throws.
    expect(signatureMatches(secret, '1790000000', 'ingest/punches', body, 'zz')).toBe(false);
  });

  it('matches the test vector published in the contract, so any client can check itself', () => {
    const vector = 'd03b57774ab52beacc6fa6485509d670f55eeff763faa674fa5f7a0372f85ae3';
    expect(signRequest('secret', '1700000000', 'ingest/heartbeat', '{}')).toBe(vector);
    expect(signRequest('secret', '1700000000', 'ingest/heartbeat', Buffer.from('{}'))).toBe(vector);
  });

  it('refuses timestamps more than 5 minutes away, and anything that is not a number', () => {
    const now = new Date('2026-09-22T06:00:00Z');
    const seconds = now.getTime() / 1000;
    expect(timestampIsFresh(String(seconds - 299), now)).toBe(true);
    expect(timestampIsFresh(String(seconds + 299), now)).toBe(true);
    expect(timestampIsFresh(String(seconds - 301), now)).toBe(false);
    expect(timestampIsFresh('soon', now)).toBe(false);
  });
});

describe('kindMayUse (which devices each signed route accepts)', () => {
  it('never lets a kiosk post raw punches, even where simulators are allowed', () => {
    expect(kindMayUse('ingest/punches', 'FACE_KIOSK', true)).toBe(false);
    expect(kindMayUse('ingest/punches', 'FACE_KIOSK', false)).toBe(false);
  });

  it('takes punches from terminals always, and from the simulator only where it is allowed', () => {
    expect(kindMayUse('ingest/punches', 'ZKTECO', false)).toBe(true);
    expect(kindMayUse('ingest/punches', 'MOCK', true)).toBe(true);
    expect(kindMayUse('ingest/punches', 'MOCK', false)).toBe(false);
  });

  it('takes heartbeats from every kind', () => {
    for (const kind of ['MOCK', 'ZKTECO', 'FACE_KIOSK'] as const) {
      expect(kindMayUse('ingest/heartbeat', kind, false)).toBe(true);
    }
  });
});

describe('staffNumberForDeviceUser', () => {
  it('reads the digits of a staff number, with or without leading zeros', () => {
    expect(staffNumberForDeviceUser('42')).toBe('SMT-00042');
    expect(staffNumberForDeviceUser('00042')).toBe('SMT-00042');
    expect(staffNumberForDeviceUser('000000042')).toBe('SMT-00042');
    expect(staffNumberForDeviceUser('SMT-00042')).toBe('SMT-00042');
  });

  it('matches nobody for anything else', () => {
    expect(staffNumberForDeviceUser('0')).toBeUndefined();
    expect(staffNumberForDeviceUser('100000')).toBeUndefined();
    expect(staffNumberForDeviceUser('smt-00042')).toBeUndefined();
    expect(staffNumberForDeviceUser('42a')).toBeUndefined();
  });
});

describe('punchPayloadHash', () => {
  const punch = {
    deviceEventId: '4471',
    deviceUserRef: '42',
    deviceTime: new Date('2026-09-22T05:58:31Z'),
    direction: 'IN',
    method: 'FINGERPRINT',
  };

  it('is the same for the same content, whatever the time zone it was written in', () => {
    expect(punchPayloadHash(punch)).toBe(
      punchPayloadHash({ ...punch, deviceTime: new Date('2026-09-22T06:58:31+01:00') }),
    );
  });

  it('changes when any field changes', () => {
    expect(punchPayloadHash({ ...punch, direction: 'OUT' })).not.toBe(punchPayloadHash(punch));
  });
});

describe('judgePunchTime', () => {
  const server = new Date('2026-09-22T06:00:00Z');

  it('trusts an ordinary punch, even one buffered for days offline', () => {
    expect(judgePunchTime(new Date('2026-09-18T06:00:00Z'), server, null)).toEqual({
      pairable: true,
      clockSuspect: false,
    });
  });

  it('never pairs impossible times, but still stores them', () => {
    expect(judgePunchTime(new Date('2019-12-31T23:00:00Z'), server, null).pairable).toBe(false);
    expect(judgePunchTime(new Date('2026-09-22T06:06:00Z'), server, null)).toEqual({
      pairable: false,
      clockSuspect: true,
    });
  });

  it('pairs a fast clock punch it can explain, but flags it', () => {
    // The device runs 7 minutes fast, so "06:06" is really about 05:59.
    expect(judgePunchTime(new Date('2026-09-22T06:06:00Z'), server, 420)).toEqual({
      pairable: true,
      clockSuspect: true,
    });
  });
});

describe('mayClockIn', () => {
  it('lets active employees clock in', () => {
    expect(mayClockIn({ status: 'ACTIVE', terminationDate: null }, '2026-09-22')).toBe(true);
  });

  it('flags people waiting for enrollment and suspended people', () => {
    expect(mayClockIn({ status: 'PENDING_ENROLLMENT', terminationDate: null }, '2026-09-22')).toBe(
      false,
    );
    expect(mayClockIn({ status: 'SUSPENDED', terminationDate: null }, '2026-09-22')).toBe(false);
  });

  it('accepts a leaver up to their last day, and flags anything after', () => {
    const leaver = { status: 'TERMINATED' as const, terminationDate: '2026-09-20' };
    expect(mayClockIn(leaver, '2026-09-20')).toBe(true);
    expect(mayClockIn(leaver, '2026-09-21')).toBe(false);
  });
});
