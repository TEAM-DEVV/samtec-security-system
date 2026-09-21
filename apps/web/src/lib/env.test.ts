import { describe, expect, it } from 'vitest';
import { toApiBaseUrl, toApiOrigin } from './env';

describe('toApiOrigin', () => {
  it('takes the origin of an absolute API address', () => {
    expect(toApiOrigin('http://localhost:3000/api/v1', 'http://localhost:5173')).toBe(
      'http://localhost:3000',
    );
  });

  it('resolves a relative API address against the page, as on the TEST deployment', () => {
    expect(toApiOrigin('/api/v1', 'https://samtec-test.vercel.app')).toBe(
      'https://samtec-test.vercel.app',
    );
  });
});

describe('toApiBaseUrl', () => {
  it('uses the local API when nothing is configured', () => {
    expect(toApiBaseUrl(undefined)).toBe('http://localhost:3000/api/v1');
  });

  it('treats an empty value as not configured', () => {
    expect(toApiBaseUrl('  ')).toBe('http://localhost:3000/api/v1');
  });

  it('removes trailing slashes', () => {
    expect(toApiBaseUrl('https://api.samtec.example/api/v1/')).toBe(
      'https://api.samtec.example/api/v1',
    );
  });
});
