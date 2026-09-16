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

const corsOrigin = z.string().refine(isBareOrigin, {
  error:
    'Each CORS origin must be a bare address like https://dashboard.example.com, with no path and no trailing slash',
});

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
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      )
      .pipe(z.array(corsOrigin).min(1, 'CORS_ORIGINS needs at least one website address')),
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
  });

export type Env = z.infer<typeof envSchema>;

/** Checks raw environment variables and returns typed, trusted values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration. Compare apps/api/.env with apps/api/.env.example.\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
