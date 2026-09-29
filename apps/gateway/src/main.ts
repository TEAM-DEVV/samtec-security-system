/**
 * The gateway, assembled: read the configuration, open the outbox, answer the
 * terminals, and keep the loops turning. `pnpm --filter @samtec/gateway start`
 * on the always-on mini PC at the site; the README covers the set-up.
 *
 * The receiving door opens first and the delivery loops are wrapped so that
 * **nothing a loop hits can bring the door down**: a gateway that crashes on
 * a bad roster answer takes the punch receiver with it, and a terminal that
 * cannot upload is a guard whose evening is on one power cut's notice.
 */
import { GatewayApi } from './api.ts';
import { loadConfig } from './config.ts';
import { Delivery } from './delivery.ts';
import { Outbox } from './outbox.ts';
import { startServer } from './server.ts';

const PUMP_EVERY_MILLISECONDS = 10_000;
const ROSTER_EVERY_MILLISECONDS = 5 * 60_000;
const HEARTBEAT_EVERY_MILLISECONDS = 5 * 60_000;
const SWEEP_EVERY_MILLISECONDS = 60 * 60_000;

// The last nets, registered before anything else can fail: a rejection that
// slipped every catch is a log line, never an exit with terminals mid-upload.
process.on('unhandledRejection', (reason) => {
  console.log(`UNHANDLED: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const config = loadConfig();
const outbox = new Outbox(config.outboxFile);
const api = new GatewayApi(config.apiUrl);
const delivery = new Delivery(api, outbox);

const gateway = await startServer(config, outbox, console.log, () => delivery.alarmedSerials());
console.log(
  `SAMTEC gateway listening on port ${gateway.port()} for ${config.terminals.length} terminal(s); ` +
    `${outbox.unsentCount()} line(s) waiting from before.`,
);

const timers: NodeJS.Timeout[] = [];
let stopping = false;
function stop(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const timer of timers) {
    clearInterval(timer);
  }
  // Whatever is mid-flight gets three seconds; the outbox makes losing the
  // race harmless, so a hung socket must not hold the shutdown hostage.
  const deadline = setTimeout(() => process.exit(0), 3_000);
  deadline.unref();
  void gateway.close().then(() => {
    outbox.close();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** One at a time per loop, and never an escaped rejection. */
function everyTick(job: () => Promise<void>, everyMilliseconds: number): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void job()
      .catch((error: unknown) => {
        console.log(`Loop failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      })
      .finally(() => {
        running = false;
      });
  }, everyMilliseconds);
}

// The first roster and pump run before the timers exist, so a fresh gateway
// is useful straight away and the first interval tick cannot race them.
for (const terminal of config.terminals) {
  await delivery.syncRoster(terminal);
  await delivery.pump(terminal);
}

timers.push(
  everyTick(async () => {
    for (const terminal of config.terminals) {
      await delivery.pump(terminal);
    }
  }, PUMP_EVERY_MILLISECONDS),
  everyTick(async () => {
    for (const terminal of config.terminals) {
      await delivery.syncRoster(terminal);
    }
  }, ROSTER_EVERY_MILLISECONDS),
  everyTick(async () => {
    for (const terminal of config.terminals) {
      await delivery.heartbeat(terminal);
    }
  }, HEARTBEAT_EVERY_MILLISECONDS),
  everyTick(async () => {
    outbox.sweep();
  }, SWEEP_EVERY_MILLISECONDS),
);
