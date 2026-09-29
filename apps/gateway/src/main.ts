/**
 * The gateway, assembled: read the configuration, open the outbox, answer the
 * terminals, and keep the loops turning. `pnpm --filter @samtec/gateway start`
 * on the always-on mini PC at the site; the README covers the set-up.
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

const config = loadConfig();
const outbox = new Outbox(config.outboxFile);
const api = new GatewayApi(config.apiUrl);
const delivery = new Delivery(api, outbox);

const gateway = await startServer(config, outbox);
console.log(
  `SAMTEC gateway listening on port ${gateway.port()} for ${config.terminals.length} terminal(s); ` +
    `${outbox.unsentCount()} line(s) waiting from before.`,
);

/** One at a time per loop: a slow site connection must not stack calls. */
function everyTick(job: () => Promise<void>, everyMilliseconds: number): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void job().finally(() => {
      running = false;
    });
  }, everyMilliseconds);
}

const timers = [
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
];

// The first roster without the five-minute wait, so a fresh gateway is useful
// straight away rather than after lunch.
for (const terminal of config.terminals) {
  await delivery.syncRoster(terminal);
  await delivery.pump(terminal);
}

function stop(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  void gateway.close().then(() => {
    outbox.close();
    process.exit(0);
  });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
