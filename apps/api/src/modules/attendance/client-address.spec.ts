import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { clientAddress } from './client-address.js';

/** Just enough of a request for the address reader. */
const asRequest = (headers: Record<string, string | string[]>, remote?: string) =>
  ({ headers, socket: { remoteAddress: remote } }) as unknown as Request;

describe('clientAddress', () => {
  it('takes the address the hosting platform wrote', () => {
    expect(clientAddress(asRequest({ 'x-vercel-forwarded-for': '41.66.10.7' }))).toBe('41.66.10.7');
  });

  it('ignores a forwarding header the kiosk set itself', () => {
    // The only header trusted is the one Vercel overwrites on every request.
    const spoofed = asRequest(
      { 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '10.0.0.2' },
      '41.66.10.7',
    );

    expect(clientAddress(spoofed)).toBe('41.66.10.7');
  });

  it('takes the first address when the platform sends a list', () => {
    const chained = asRequest({ 'x-vercel-forwarded-for': '41.66.10.7, 10.0.0.9' });

    expect(clientAddress(chained)).toBe('41.66.10.7');
  });

  it('falls back to the socket anywhere else, unwrapping IPv4 in IPv6 clothing', () => {
    expect(clientAddress(asRequest({}, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
    expect(clientAddress(asRequest({}, '2001:db8::1'))).toBe('2001:db8::1');
  });

  it('records nothing rather than a guess', () => {
    // The column takes an address or nothing; a made-up one is worse.
    expect(clientAddress(asRequest({ 'x-vercel-forwarded-for': 'not-an-address' }))).toBeNull();
    expect(clientAddress(asRequest({ 'x-vercel-forwarded-for': '999.1.1.1' }))).toBeNull();
    expect(clientAddress(asRequest({ 'x-vercel-forwarded-for': ':::' }))).toBeNull();
    expect(clientAddress(asRequest({ 'x-vercel-forwarded-for': '1:2:3:4:5:6:7:8:9' }))).toBeNull();
    expect(clientAddress(asRequest({}, ''))).toBeNull();
    expect(clientAddress(asRequest({}))).toBeNull();
  });
});
