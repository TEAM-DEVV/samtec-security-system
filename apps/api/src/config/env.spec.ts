import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const minimalEnv = { DATABASE_URL: 'postgresql://samtec:secret@localhost:5432/samtec_test' };

describe('parseEnv', () => {
  it('fills in safe defaults for optional values', () => {
    const env = parseEnv(minimalEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('turns a comma-separated CORS_ORIGINS value into a list', () => {
    const env = parseEnv({
      ...minimalEnv,
      CORS_ORIGINS: 'http://localhost:5173, https://dashboard.samtec.example',
    });

    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://dashboard.samtec.example']);
  });

  it.each([
    'http://localhost:5173/',
    'https://dashboard.samtec.example/app',
    'dashboard.samtec.example',
    'ftp://dashboard.samtec.example',
  ])('rejects %s as a CORS origin, because browsers never send that form', (origin) => {
    expect(() => parseEnv({ ...minimalEnv, CORS_ORIGINS: origin })).toThrow(/CORS origin/);
  });

  it('requires https CORS origins in production', () => {
    expect(() =>
      parseEnv({
        ...minimalEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'http://dashboard.samtec.example',
      }),
    ).toThrow(/https/);

    expect(
      parseEnv({
        ...minimalEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://dashboard.samtec.example',
      }).CORS_ORIGINS,
    ).toEqual(['https://dashboard.samtec.example']);
  });

  it('refuses to start without a database URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a database URL that is not PostgreSQL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://root@localhost/samtec' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('never repeats secret values in its error message', () => {
    const parseWithPassword = () =>
      parseEnv({ DATABASE_URL: 'mysql://root:super-secret-password@localhost/samtec' });

    expect(parseWithPassword).toThrow();
    expect(parseWithPassword).not.toThrow(/super-secret-password/);
  });
});
