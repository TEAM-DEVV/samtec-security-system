import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Loads `apps/api/.env` into `process.env` when the file exists.
 * Uses the loader built into Node.js, so no extra package is needed.
 * Variables that are already set, for example by CI, are kept.
 */
export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

/**
 * True for a bare website address such as `https://dashboard.samtec.example`:
 * http or https, with no path, query or trailing slash. Browsers send exactly
 * this form in the `Origin` header, so any other form would never match.
 */
function isBareOrigin(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  );
}

const bareOrigin = z.string().refine(isBareOrigin, {
  error:
    'Each origin must be a bare address like https://dashboard.example.com, with no path and no trailing slash',
});

/** Turns "a, b" into ["a", "b"], ignoring stray spaces and empty entries. */
const originList = z.string().transform((value) =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
);

/**
 * The AUTH_SECRET used when none is set. Only for development on a developer's
 * own computer: the API refuses to start in production with this value,
 * because everyone can read it here.
 */
export const DEV_AUTH_SECRET = 'dev-only-auth-secret-never-use-outside-localhost';

/**
 * Every environment variable the API reads, and the rule each one must follow.
 *
 * The API refuses to start when a value is missing or wrong ("fail fast"), so
 * configuration mistakes appear at startup instead of in the middle of a request.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.url({
      protocol: /^postgres(ql)?$/,
      error:
        'DATABASE_URL must be a PostgreSQL URL like postgresql://user:password@host:5432/database',
    }),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .pipe(originList)
      .pipe(z.array(bareOrigin).min(1, 'CORS_ORIGINS needs at least one website address')),
    /**
     * The addresses the kiosk app is served from (docs/plan/13 section 2). A
     * sign-in from one of these gets no refresh cookie and a token that only
     * works on the kiosk screens. Empty until a kiosk is deployed, and never
     * an address that is also in CORS_ORIGINS.
     */
    KIOSK_ORIGINS: z.string().default('').pipe(originList).pipe(z.array(bareOrigin)),
    /**
     * The one secret behind sign-in. Access tokens are signed with a key
     * derived from it, and authenticator secrets are encrypted with another.
     * Changing it signs everyone out, and makes every stored authenticator
     * and device secret unreadable (re-register or rotate every device).
     * Make one with:
     * node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     */
    AUTH_SECRET: z
      .string()
      .min(32, 'AUTH_SECRET must be at least 32 characters of random text')
      .default(DEV_AUTH_SECRET),
    /** Which biometric provider the attendance module uses (docs/plan/10). Phase 3 adds the real ones. */
    BIOMETRIC_PROVIDER: z.enum(['mock']).optional(),
    /**
     * Whether devices of kind MOCK (the simulator) may send punches. When it
     * is not set, simulators are allowed in development and tests and refused
     * in production (a safe default). The TEST environment runs in
     * production mode and sets `yes`, because its attendance demo uses the
     * simulator; a client's production never does.
     */
    ALLOW_SIMULATOR_DEVICES: z.enum(['yes', 'no']).optional(),
  })
  .superRefine((env, context) => {
    // A production dashboard is always served over HTTPS.
    if (
      env.NODE_ENV === 'production' &&
      env.CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'In production, every CORS origin must start with https://',
      });
    }
    // A production kiosk is always served over HTTPS, like the dashboard.
    if (
      env.NODE_ENV === 'production' &&
      env.KIOSK_ORIGINS.some((origin) => !origin.startsWith('https://'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['KIOSK_ORIGINS'],
        message: 'In production, every kiosk origin must start with https://',
      });
    }
    // One address can never be both, or a kiosk sign-in could get a dashboard
    // session (or the other way round) depending on which list was read first.
    const shared = env.KIOSK_ORIGINS.filter((origin) => env.CORS_ORIGINS.includes(origin));
    if (shared.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['KIOSK_ORIGINS'],
        message: `CORS_ORIGINS and KIOSK_ORIGINS must not share an address: ${shared.join(', ')}`,
      });
    }
    // The built-in development secret is public knowledge, so production
    // refuses to start with it.
    if (env.NODE_ENV === 'production' && env.AUTH_SECRET === DEV_AUTH_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'In production, AUTH_SECRET must be set to a random value of your own',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Checks raw environment variables and returns typed, trusted values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse({
    ...source,
    // On Vercel, the Supabase integration provides the database connection
    // under its own names. POSTGRES_PRISMA_URL points at the connection
    // pooler, which is what a serverless API should use at runtime.
    // An explicit DATABASE_URL always wins.
    DATABASE_URL: source.DATABASE_URL ?? source.POSTGRES_PRISMA_URL ?? source.POSTGRES_URL,
  });
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration. Compare apps/api/.env with apps/api/.env.example.\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
