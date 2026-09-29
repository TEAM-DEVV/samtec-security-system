/**
 * Delivery: what leaves the outbox, and the roster coming back.
 *
 * Everything here is a loop that can fail and try again, because the mini PC
 * at a site has the site's internet. The rules (docs/plan/13 section 5):
 *
 * - Punches leave in signed batches of at most 100, oldest first, and a row
 *   is marked sent only when the API's answer **names that row**. A 200 that
 *   fails to name a row leaves it waiting and is said loudly: a captive
 *   portal's cheerful 200 must never count as delivery.
 * - An outage (a 5xx, a timeout) leaves the rows where they are; the next
 *   tick tries again.
 * - A **rejection** (400/413) means some row in the batch is malformed. The
 *   batch is halved until the guilty row is alone, that row is marked
 *   rejected — kept as evidence, never resent, never blocking the rows
 *   behind it — and an alarm is logged.
 * - A `401` is an **alarm**, not a retry: only an administrator fixes it.
 *   The terminal is retried once every five minutes in case they just did.
 * - The roster is re-asked every 5 minutes and is safe to repeat. Whoever is
 *   on it and not yet on the terminal is added; whoever the terminal holds
 *   and the roster no longer names is removed — which is how a face blocked
 *   as a duplicate gets its fingers taken off the terminals too. What the
 *   terminal holds is what it has **acknowledged**, so a lost command is
 *   simply served again rather than assumed done.
 */
import { ApiRequestRejected, type GatewayApi, TerminalNotTrusted } from './api.ts';
import type { TerminalConfig } from './config.ts';
import { addUserPayload, deleteUserPayload, SAFE_USER_REF } from './iclock.ts';
import { BATCH_LIMIT, type Outbox, type OutboxRow } from './outbox.ts';

/** How long an alarmed terminal rests between slow retries. */
const ALARM_RETRY_MILLISECONDS = 5 * 60_000;

interface PunchResults {
  results?: { deviceEventId: string; status: string }[];
}

interface EnrollmentResults {
  results?: { deviceUserRef: string; enrolledAt: string; status: string }[];
}

interface RosterAnswer {
  users?: { deviceUserRef: string; staffNumber: string; displayName: string }[];
}

export class Delivery {
  private readonly api: GatewayApi;
  private readonly outbox: Outbox;
  private readonly log: (line: string) => void;
  /** Alarmed terminals: when each may try again, and that it was said once. */
  private readonly alarmedUntil = new Map<string, number>();

  constructor(api: GatewayApi, outbox: Outbox, log: (line: string) => void = console.log) {
    this.api = api;
    this.outbox = outbox;
    this.log = log;
  }

  /** The serials currently refused by the API, for the health line. */
  alarmedSerials(): string[] {
    return [...this.alarmedUntil.keys()].sort();
  }

  /** One pump tick for one terminal: every waiting batch, punches then proofs. */
  async pump(terminal: TerminalConfig): Promise<void> {
    const restUntil = this.alarmedUntil.get(terminal.serial);
    if (restUntil !== undefined && Date.now() < restUntil) {
      return;
    }
    try {
      await this.pumpKind(terminal, 'PUNCH');
      await this.pumpKind(terminal, 'ENROLLMENT');
      if (this.alarmedUntil.delete(terminal.serial)) {
        this.log(`${terminal.serial}: the API accepts this terminal again.`);
      }
    } catch (error) {
      if (error instanceof TerminalNotTrusted) {
        // Said loudly once, then one slow retry per rest in case an
        // administrator has switched the device on or rotated the secret.
        if (!this.alarmedUntil.has(terminal.serial)) {
          this.log(`ALARM ${terminal.serial}: ${error.message}`);
        }
        this.alarmedUntil.set(terminal.serial, Date.now() + ALARM_RETRY_MILLISECONDS);
        return;
      }
      // An outage: say so once per tick and leave the rows for the next one.
      this.log(`${terminal.serial}: delivery failed (${describeQuietly(error)}); will retry.`);
    }
  }

  private async pumpKind(terminal: TerminalConfig, kind: OutboxRow['kind']): Promise<void> {
    // Keeps going until the outbox has nothing waiting, so a terminal that
    // was offline for a day drains in a few passes of at most 100 each. A
    // pass that settles nothing ends the tick instead of spinning: rows a
    // suspect 200 left unanswered would otherwise be re-fetched forever.
    for (;;) {
      const batch = this.outbox.nextBatch(terminal.serial, kind, BATCH_LIMIT);
      if (batch.length === 0) {
        return;
      }
      await this.sendRows(terminal, kind, batch);
      const waiting = new Set(
        this.outbox.nextBatch(terminal.serial, kind, BATCH_LIMIT).map((row) => row.id),
      );
      if (batch.some((row) => waiting.has(row.id))) {
        return;
      }
    }
  }

  /**
   * Sends one batch. On a rejection the batch is halved until the malformed
   * row stands alone, so one poisoned line costs a few extra requests, never
   * the terminal's whole delivery.
   */
  private async sendRows(
    terminal: TerminalConfig,
    kind: OutboxRow['kind'],
    batch: OutboxRow[],
  ): Promise<void> {
    try {
      if (kind === 'PUNCH') {
        await this.sendPunches(terminal, batch);
      } else {
        await this.sendEnrollments(terminal, batch);
      }
    } catch (error) {
      if (error instanceof ApiRequestRejected && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await this.sendRows(terminal, kind, batch.slice(0, middle));
        await this.sendRows(terminal, kind, batch.slice(middle));
        return;
      }
      if (error instanceof ApiRequestRejected) {
        const row = batch[0];
        if (row !== undefined) {
          this.outbox.markRejected([row.id]);
          this.log(
            `ALARM ${terminal.serial}: the API rejected one ${kind.toLowerCase()} row as ` +
              `malformed (kept as evidence, id ${row.id}). Later rows are not held up by it.`,
          );
        }
        return;
      }
      throw error;
    }
  }

  private async sendPunches(terminal: TerminalConfig, batch: OutboxRow[]): Promise<void> {
    const rows = batch.map((row) => JSON.parse(row.payload) as { deviceEventId: string });
    const answer = await this.api.call<PunchResults>(terminal, 'ingest/punches', {
      // The gateway sends on the terminal's behalf; its own clock stands in,
      // so the server can still measure how far this site's time has drifted.
      deviceClockAt: new Date().toISOString(),
      punches: rows,
    });
    const answered = new Map(
      (Array.isArray(answer.results) ? answer.results : []).map((result) => [
        result.deviceEventId,
        result.status,
      ]),
    );
    this.finishBatch(
      terminal,
      batch,
      rows.map((row) => row.deviceEventId),
      answered,
    );
  }

  private async sendEnrollments(terminal: TerminalConfig, batch: OutboxRow[]): Promise<void> {
    const rows = batch.map(
      (row) => JSON.parse(row.payload) as { deviceUserRef: string; enrolledAt: string },
    );
    const answer = await this.api.call<EnrollmentResults>(terminal, 'ingest/enrollments', {
      enrollments: rows,
    });
    const answered = new Map(
      (Array.isArray(answer.results) ? answer.results : []).map((result) => [
        `${result.deviceUserRef}@${result.enrolledAt}`,
        result.status,
      ]),
    );
    this.finishBatch(
      terminal,
      batch,
      rows.map((row) => `${row.deviceUserRef}@${row.enrolledAt}`),
      answered,
    );
  }

  /** Marks sent exactly the rows the answer named, and says so for the rest. */
  private finishBatch(
    terminal: TerminalConfig,
    batch: OutboxRow[],
    keys: string[],
    answered: Map<string, string>,
  ): void {
    const sent: number[] = [];
    let unanswered = 0;
    let conflicts = 0;
    batch.forEach((row, index) => {
      const key = keys[index] ?? '';
      const status = answered.get(key);
      if (status === undefined) {
        unanswered += 1;
        return;
      }
      if (status === 'CONFLICT') {
        // The API kept its earlier version and audited the difference; the
        // row is delivered in the only sense that matters, and named here.
        conflicts += 1;
      }
      sent.push(row.id);
    });
    this.outbox.markSent(sent);
    if (conflicts > 0) {
      this.log(
        `${terminal.serial}: ${conflicts} row(s) conflicted with what the API already held; ` +
          'its earlier version stands and the difference is audited there.',
      );
    }
    if (unanswered > 0) {
      this.log(
        `ALARM ${terminal.serial}: a 200 answered for only ${answered.size} of ` +
          `${batch.length} row(s). The ${unanswered} unanswered stay waiting — if this ` +
          'repeats, something between here and the API is rewriting responses.',
      );
    }
  }

  /** One roster tick for one terminal: ask, diff, queue the difference. */
  async syncRoster(terminal: TerminalConfig): Promise<void> {
    try {
      const roster = await this.api.call<RosterAnswer>(terminal, 'ingest/roster', {});
      const users = Array.isArray(roster.users) ? roster.users : [];
      const known = new Map(
        this.outbox.knownUsers(terminal.serial).map((user) => [user.deviceUserRef, user]),
      );
      const listed = new Map(users.map((user) => [user.deviceUserRef, user]));

      for (const [ref, user] of listed) {
        if (!SAFE_USER_REF.test(ref)) {
          this.log(`${terminal.serial}: roster user ref not usable on a terminal; skipped.`);
          continue;
        }
        if (!known.has(ref) && !this.outbox.commandOpen(terminal.serial, 'ADD', ref)) {
          this.outbox.queueCommand(
            terminal.serial,
            'ADD',
            ref,
            user.displayName,
            addUserPayload(ref, user.displayName),
          );
        }
      }
      for (const ref of known.keys()) {
        if (!listed.has(ref) && !this.outbox.commandOpen(terminal.serial, 'DELETE', ref)) {
          this.outbox.queueCommand(terminal.serial, 'DELETE', ref, '', deleteUserPayload(ref));
        }
      }
    } catch (error) {
      this.log(`${terminal.serial}: roster not read (${describeQuietly(error)}); will retry.`);
    }
  }

  /** The tick the server's own time-based checks ride on. */
  async heartbeat(terminal: TerminalConfig): Promise<void> {
    try {
      await this.api.call<unknown>(terminal, 'ingest/heartbeat', {});
    } catch {
      // The next punch or roster call says everything a missed beat would.
    }
  }
}

/** One line for the log, never a stack trace scrolling the alarm away. */
function describeQuietly(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
