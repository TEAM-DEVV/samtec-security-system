import { describe, expect, it } from 'vitest';
import { toApiBaseUrl } from './env';

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
