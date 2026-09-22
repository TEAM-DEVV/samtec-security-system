import { describe, expect, it } from 'vitest';
import { AppConfig } from './app-config.js';
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

  const productionEnv = {
    ...minimalEnv,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://dashboard.samtec.example',
    AUTH_SECRET: 'a-real-production-secret-with-32-chars!!',
  };

  it('requires https CORS origins in production', () => {
    expect(() =>
      parseEnv({ ...productionEnv, CORS_ORIGINS: 'http://dashboard.samtec.example' }),
    ).toThrow(/https/);

    expect(
      parseEnv({ ...productionEnv, CORS_ORIGINS: 'https://dashboard.samtec.example' }).CORS_ORIGINS,
    ).toEqual(['https://dashboard.samtec.example']);
  });

  it('allows the built-in development AUTH_SECRET only outside production', () => {
    expect(parseEnv(minimalEnv).AUTH_SECRET.length).toBeGreaterThanOrEqual(32);

    expect(() => parseEnv({ ...minimalEnv, NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...productionEnv, AUTH_SECRET: 'too-short' })).toThrow(/AUTH_SECRET/);
    expect(parseEnv(productionEnv).AUTH_SECRET).toBe(productionEnv.AUTH_SECRET);
  });

  it('refuses to start without a database URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('accepts the Supabase integration names for the database URL, preferring an explicit one', () => {
    const pooled = 'postgresql://samtec:secret@pooler.example:6543/postgres';

    expect(parseEnv({ POSTGRES_PRISMA_URL: pooled }).DATABASE_URL).toBe(pooled);
    expect(parseEnv({ POSTGRES_URL: pooled }).DATABASE_URL).toBe(pooled);
    expect(parseEnv({ ...minimalEnv, POSTGRES_PRISMA_URL: pooled }).DATABASE_URL).toBe(
      minimalEnv.DATABASE_URL,
    );
  });

  it('rejects a database URL that is not PostgreSQL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://root@localhost/samtec' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('allows simulator devices in development and tests, and refuses them in production unless set', () => {
    const allowed = (source: Record<string, string>) =>
      new AppConfig(parseEnv(source)).allowSimulatorDevices;

    expect(allowed(minimalEnv)).toBe(true);
    expect(allowed({ ...minimalEnv, NODE_ENV: 'test' })).toBe(true);
    expect(allowed({ ...minimalEnv, ALLOW_SIMULATOR_DEVICES: 'no' })).toBe(false);
    // Production is safe by default; TEST opts in explicitly.
    expect(allowed(productionEnv)).toBe(false);
    expect(allowed({ ...productionEnv, ALLOW_SIMULATOR_DEVICES: 'yes' })).toBe(true);
    expect(() => parseEnv({ ...minimalEnv, ALLOW_SIMULATOR_DEVICES: 'maybe' })).toThrow(
      /ALLOW_SIMULATOR_DEVICES/,
    );
  });

  it('never repeats secret values in its error message', () => {
    const parseWithPassword = () =>
      parseEnv({ DATABASE_URL: 'mysql://root:super-secret-password@localhost/samtec' });

    expect(parseWithPassword).toThrow();
    expect(parseWithPassword).not.toThrow(/super-secret-password/);
  });
});
