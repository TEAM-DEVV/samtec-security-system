import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma does not read .env files by itself, so load apps/api/.env when it
// exists. The file may be missing in CI or on a frontend-only machine, and that
// is fine: `prisma generate` does not need a database.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Commands that need a database (migrate, seed, studio) fail with a clear
    // "can't reach database" error while this is empty.
    //
    // On Vercel, the Supabase integration provides the connection under its
    // own names instead of DATABASE_URL. Migrations use the NON_POOLING
    // (direct) connection: schema changes must not go through the pooler.
    url:
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL_NON_POOLING ??
      process.env.POSTGRES_URL ??
      '',
  },
});
