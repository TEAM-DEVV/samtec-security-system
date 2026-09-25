/**
 * The Phase 7 load test: a burst of punches through the real, signed ingest
 * endpoint, measured (docs/plan/07-roadmap.md; the numbers go in the report's
 * security chapter).
 *
 * It answers three questions a reader of the report will ask:
 *
 * 1. **Is anything lost or double-counted under load?** Every punch is sent
 *    once, then the whole burst is sent again. The first pass must accept all
 *    of them and the second must call all of them duplicates — that is the
 *    idempotency promise, tested at size rather than one punch at a time.
 * 2. **How long does it take?** Per-batch timings, so the report can say what
 *    a terminal that was offline for a day costs when it reconnects.
 * 3. **What happens when batches arrive together?** Punches are written under
 *    one lock per company, so parallel batches meet it. The API must shed
 *    them politely — `503` with `Retry-After` — never lose them or fail.
 *
 * On this computer (after `pnpm db:seed`, with the API running):
 *
 *   pnpm --filter @samtec/api load:punches
 *
 * Against any other API, register a MOCK device, have a second administrator
 * switch it on (docs/plan/06, "Two administrators"), then:
 *
 *   API_URL=https://… DEVICE_ID=… DEVICE_SECRET=… pnpm --filter @samtec/api load:punches
 *
 * The secret comes from the environment, never an option: other users on a
 * computer can read a program's options but not its environment.
 */
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { isOnThisComputer } from '../src/config/local-database.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { signRequest } from '../src/modules/attendance/device-signature.js';
import { DEMO_DEVICES, demoDeviceSecret } from './demo-devices.js';
import type { SimulatedDevice, SimulatedPunch } from './device-simulator.js';

/** The contract's limit: at most 100 punches in one request. */
const BATCH_SIZE = 100;

/** Retries after a busy or rate-limited answer, as a real terminal does. */
const MAX_ATTEMPTS = 6;

const { values } = parseArgs({
  // pnpm passes its `--` separator through, which would end the options.
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    punches: { type: 'string', default: '1000' },
    /** How many batches are in flight at once. 1 is a single reconnecting terminal. */
    parallel: { type: 'string', default: '4' },
  },
});

const punchCount = Number(values.punches);
if (!Number.isInteger(punchCount) || punchCount < 1 || punchCount > 20_000) {
  throw new Error('--punches must be a whole number from 1 to 20000.');
}
const parallel = Number(values.parallel);
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) {
  throw new Error('--parallel must be a whole number from 1 to 16.');
}

const device = await chooseDevice();
const punches = makePunches(punchCount);

console.log(
  `Sending ${punchCount} punches to ${device.apiUrl} in ${Math.ceil(punchCount / BATCH_SIZE)} batches, ${parallel} at a time.\n`,
);

const first = await burst(device, punches, parallel);
report('First pass', first);

const again = await burst(device, punches, parallel);
report('Sent again', again);

const problems: string[] = [];
if (first.accepted !== punchCount) {
  problems.push(`First pass accepted ${first.accepted} of ${punchCount}.`);
}
if (again.duplicates !== punchCount) {
  problems.push(`Sending again called only ${again.duplicates} of ${punchCount} duplicates.`);
}
if (first.conflicts + again.conflicts > 0) {
  problems.push(`${first.conflicts + again.conflicts} punches came back as conflicts.`);
}
if (problems.length > 0) {
  console.error(`\nSomething is wrong:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(
    '\nEvery punch was stored exactly once, and sending the whole burst again changed nothing.',
  );
}

// ---------------------------------------------------------------------------

interface BurstResult {
  accepted: number;
  duplicates: number;
  conflicts: number;
  /** Answers that said "busy" or "too many", and were retried. */
  waited: number;
  /**
   * How long each batch took, in milliseconds — **the request that worked**,
   * not the waiting before it. Counting the wait would put this script's own
   * deliberate sleep into a number the report presents as server speed.
   */
  batchMs: number[];
  /** Time spent waiting after a "busy" answer, which is the shedding, not the work. */
  waitedMs: number;
  totalMs: number;
}

/** Sends every batch, up to `parallel` at a time, and times each one. */
async function burst(
  target: SimulatedDevice,
  all: SimulatedPunch[],
  atOnce: number,
): Promise<BurstResult> {
  const batches: SimulatedPunch[][] = [];
  for (let start = 0; start < all.length; start += BATCH_SIZE) {
    batches.push(all.slice(start, start + BATCH_SIZE));
  }
  const result: BurstResult = {
    accepted: 0,
    duplicates: 0,
    conflicts: 0,
    waited: 0,
    batchMs: [],
    waitedMs: 0,
    totalMs: 0,
  };
  const startedAt = Date.now();
  let next = 0;
  const workers = Array.from({ length: Math.min(atOnce, batches.length) }, async () => {
    for (;;) {
      const batch = batches[next++];
      if (!batch) {
        return;
      }
      const answer = await sendBatch(target, batch, result);
      result.batchMs.push(answer.tookMs);
      result.accepted += answer.accepted;
      result.duplicates += answer.duplicates;
      result.conflicts += answer.conflicts;
    }
  });
  await Promise.all(workers);
  result.totalMs = Date.now() - startedAt;
  return result;
}

interface IngestAnswer {
  accepted: number;
  duplicates: number;
  conflicts: number;
}

/** What the API answered, and how long that one request took. */
type BatchOutcome = IngestAnswer & { tookMs: number };

/** One signed batch, retried after a busy or rate-limited answer. */
async function sendBatch(
  target: SimulatedDevice,
  batch: SimulatedPunch[],
  result: BurstResult,
): Promise<BatchOutcome> {
  const text = JSON.stringify({ deviceClockAt: new Date().toISOString(), punches: batch });
  for (let attempt = 1; ; attempt += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const startedAt = Date.now();
    const response = await fetch(`${target.apiUrl}/ingest/punches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Samtec-Device': target.id,
        'X-Samtec-Timestamp': timestamp,
        'X-Samtec-Signature': signRequest(target.secret, timestamp, 'ingest/punches', text),
      },
      body: text,
    });
    if ((response.status === 503 || response.status === 429) && attempt < MAX_ATTEMPTS) {
      result.waited += 1;
      const seconds = Number(response.headers.get('retry-after') ?? '1');
      const waitFrom = Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.max(seconds, 1) * 1000));
      result.waitedMs += Date.now() - waitFrom;
      continue;
    }
    if (!response.ok) {
      throw new Error(`ingest/punches answered ${response.status}: ${await response.text()}`);
    }
    const tookMs = Date.now() - startedAt;
    return { ...((await response.json()) as IngestAnswer), tookMs };
  }
}

function report(title: string, result: BurstResult): void {
  const sorted = [...result.batchMs].sort((left, right) => left - right);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
  const perSecond =
    result.totalMs === 0
      ? 0
      : Math.round((result.accepted + result.duplicates) / (result.totalMs / 1000));
  console.log(`${title}`);
  console.log(
    `  accepted ${result.accepted}, duplicates ${result.duplicates}, conflicts ${result.conflicts}`,
  );
  console.log(
    `  took ${(result.totalMs / 1000).toFixed(1)}s — about ${perSecond} punches a second`,
  );
  console.log(
    `  the request that worked, for a batch of ${BATCH_SIZE}: fastest ${sorted[0] ?? 0}ms, middle ${at(0.5)}ms, slowest ${sorted.at(-1) ?? 0}ms`,
  );
  console.log(
    `  answered "busy, try again" ${result.waited} time(s), spent ${(result.waitedMs / 1000).toFixed(1)}s waiting after those\n`,
  );
}

/** One punch per event, spread over the last day, all for the same worker. */
function makePunches(count: number): SimulatedPunch[] {
  const run = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    // Unique per run, so a second run of the script measures a fresh burst
    // rather than a pile of duplicates.
    deviceEventId: `load-${run}-${index}`,
    deviceUserRef: '1',
    deviceTime: new Date(run - (count - index) * 1000).toISOString(),
    direction: index % 2 === 0 ? ('IN' as const) : ('OUT' as const),
    method: 'FINGERPRINT' as const,
  }));
}

/** The device from the environment, or the first seeded demo device here. */
async function chooseDevice(): Promise<SimulatedDevice> {
  const { API_URL: apiUrl, DEVICE_ID: id, DEVICE_SECRET: secret } = process.env;
  if (apiUrl && id && secret) {
    return { apiUrl, id, secret };
  }
  if (apiUrl || id || secret) {
    throw new Error('Set API_URL, DEVICE_ID and DEVICE_SECRET together.');
  }
  loadEnvFile();
  const env = parseEnv(process.env);
  if (!isOnThisComputer(env.DATABASE_URL)) {
    throw new Error(
      'Without API_URL, DEVICE_ID and DEVICE_SECRET this uses the demo devices, which exist only on this computer.',
    );
  }
  const demo = DEMO_DEVICES[0];
  if (!demo) {
    throw new Error('No demo device is defined.');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const row = await prisma.device.findFirst({ where: { name: demo.name } });
    if (!row) {
      throw new Error(`No device named "${demo.name}". Run pnpm db:seed first.`);
    }
    return {
      apiUrl: `http://localhost:${env.PORT}/api/v1`,
      id: row.id,
      secret: demoDeviceSecret(env.AUTH_SECRET, demo.name),
    };
  } finally {
    await prisma.$disconnect();
  }
}
