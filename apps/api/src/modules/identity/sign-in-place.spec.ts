import { describe, expect, it } from 'vitest';
import { placeOfToken, signInPlace, stampPlace } from './sign-in-place.js';

const DASHBOARD = ['https://dashboard.samtec.example'];
const KIOSKS = ['https://kiosk-one.samtec.example', 'https://kiosk-two.samtec.example'];

describe('signInPlace', () => {
  it('tells the dashboard and a kiosk apart by the address the page came from', () => {
    expect(signInPlace('https://dashboard.samtec.example', DASHBOARD, KIOSKS)).toBe('DASHBOARD');
    expect(signInPlace('https://kiosk-two.samtec.example', DASHBOARD, KIOSKS)).toBe('KIOSK');
  });

  it('refuses every other address, and a request with none', () => {
    expect(signInPlace('https://someone-else.example', DASHBOARD, KIOSKS)).toBeNull();
    // Close, but not the same address: the port and the scheme both count.
    expect(signInPlace('http://dashboard.samtec.example', DASHBOARD, KIOSKS)).toBeNull();
    expect(signInPlace('https://dashboard.samtec.example:8443', DASHBOARD, KIOSKS)).toBeNull();
    expect(signInPlace(undefined, DASHBOARD, KIOSKS)).toBeNull();
    expect(signInPlace('', DASHBOARD, KIOSKS)).toBeNull();
  });

  it('works when no kiosk is deployed yet', () => {
    expect(signInPlace('https://dashboard.samtec.example', DASHBOARD, [])).toBe('DASHBOARD');
    expect(signInPlace('https://kiosk-one.samtec.example', DASHBOARD, [])).toBeNull();
  });
});

describe('the letter a half-done sign-in carries', () => {
  it('says where the sign-in started', () => {
    const kiosk = stampPlace('KIOSK', 'abc123');
    const dashboard = stampPlace('DASHBOARD', 'abc123');

    expect(placeOfToken(kiosk)).toBe('KIOSK');
    expect(placeOfToken(dashboard)).toBe('DASHBOARD');
    // The two are different tokens, so one can never be used as the other.
    expect(kiosk).not.toBe(dashboard);
  });

  it('says nothing for a token without one', () => {
    expect(placeOfToken('abc123')).toBeNull();
    expect(placeOfToken('')).toBeNull();
    expect(placeOfToken('x.abc123')).toBeNull();
  });
});
