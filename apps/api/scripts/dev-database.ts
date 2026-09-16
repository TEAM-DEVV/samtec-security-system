/**
 * Starts a real PostgreSQL 17 server for local development, with no Docker and
 * no installer. Run `pnpm db:start` from the repository root and leave that
 * terminal open. Press Ctrl+C to stop the database.
 *
 * Data is stored in apps/api/.local-db (ignored by git), so tables survive
 * restarts. Delete that folder to start again from an empty database.
 *
 * The username and password below are for this local database only. Never
 * reuse them anywhere else.
 */
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const DATA_DIRECTORY = '.local-db';
const PORT = 54329;
const USER = 'samtec';
const PASSWORD = 'samtec-local-only';
const DATABASE = 'samtec_dev';

const postgres = new EmbeddedPostgres({
  databaseDir: DATA_DIRECTORY,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

if (!existsSync(`${DATA_DIRECTORY}/PG_VERSION`)) {
  console.log('Creating the local database files (first run only)...');
  await postgres.initialise();
}

await postgres.start();

const client = postgres.getPgClient();
await client.connect();
const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
await client.end();
if (existing.rowCount === 0) {
  await postgres.createDatabase(DATABASE);
}

console.log(`
PostgreSQL is running on port ${PORT}.
apps/api/.env should contain:

  DATABASE_URL=postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}

Keep this terminal open. Press Ctrl+C to stop the database.
`);

async function shutDown(): Promise<void> {
  await postgres.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutDown());
process.on('SIGTERM', () => void shutDown());
