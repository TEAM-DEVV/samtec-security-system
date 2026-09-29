/**
 * Delivery: what leaves the outbox, and the roster coming back.
 *
 * Everything here is a loop that can fail and try again, because the mini PC
 * at a site has the site's internet. The rules (docs/plan/13 section 5):
 *
 * - Punches leave in signed batches of at most 100, oldest first, and a row
 *   is marked sent only after the API answered for it. A server error or a
 *   timeout leaves the rows where they are; the next tick tries again.
 * - A `401` is an **alarm**, not a retry: this terminal's key is wrong or the
 *   device was switched off, and only an administrator fixes that. The pump
 *   backs off to one slow try per interval so the alarm does not scroll away.
 * - The roster is re-asked every 5 minutes and is safe to repeat. Whoever is
 *   on it and unknown to the terminal is added; whoever the terminal knows
 *   and the roster no longer names is removed — which is how a face blocked
 *   as a duplicate gets its fingers taken off the terminals too.
 */
import { type GatewayApi, TerminalNotTrusted } from './api.ts';
import type { TerminalConfig } from './config.ts';
import { addUserCommand, deleteUserCommand } from './iclock.ts';
import { BATCH_LIMIT, type Outbox } from './outbox.ts';

interface PunchResults {
  results: { deviceEventId: string; status: string }[];
}

interface RosterAnswer {
  users: { deviceUserRef: string; staffNumber: string; displayName: string }[];
  serverTime: string;
}

export class Delivery {
  private readonly api: GatewayApi;
  private readonly outbox: Outbox;
  private readonly log: (line: string) => void;
  /** Terminals the API refused: alarm raised, retried slowly, never dropped. */
  private readonly alarmed = new Set<string>();
  private commandId = Date.now() % 1_000_000;

  constructor(api: GatewayApi, outbox: Outbox, log: (line: string) => void = console.log) {
    this.api = api;
    this.outbox = outbox;
    this.log = log;
  }

  /** One pump tick for one terminal: every waiting batch, punches then proofs. */
  async pump(terminal: TerminalConfig): Promise<void> {
    try {
      await this.pumpKind(terminal, 'PUNCH');
      await this.pumpKind(terminal, 'ENROLLMENT');
      if (this.alarmed.delete(terminal.serial)) {
        this.log(`${terminal.serial}: the API accepts this terminal again.`);
      }
    } catch (error) {
      if (error instanceof TerminalNotTrusted) {
        // Once per alarm, loudly; retried next tick in case an administrator
        // has switched the device on or rotated the secret meanwhile.
        if (!this.alarmed.has(terminal.serial)) {
          this.alarmed.add(terminal.serial);
          this.log(`ALARM ${terminal.serial}: ${error.message}`);
        }
        return;
      }
      // An outage: say so once per tick and leave the rows for the next one.
      this.log(`${terminal.serial}: delivery failed (${describeQuietly(error)}); will retry.`);
    }
  }

  private async pumpKind(terminal: TerminalConfig, kind: 'PUNCH' | 'ENROLLMENT'): Promise<void> {
    // Keeps going until the outbox has nothing waiting, so a terminal that
    // was offline for a day drains in a few ticks of at most 100 each.
    for (;;) {
      const batch = this.outbox.nextBatch(terminal.serial, kind, BATCH_LIMIT);
      if (batch.length === 0) {
        return;
      }
      const rows = batch.map((row) => JSON.parse(row.payload) as object);
      if (kind === 'PUNCH') {
        await this.api.call<PunchResults>(terminal, 'ingest/punches', { punches: rows });
      } else {
        await this.api.call<unknown>(terminal, 'ingest/enrollments', { enrollments: rows });
      }
      // Marked sent only now: the API has answered for every row in the
      // batch, whatever it said about each (DUPLICATE and CONFLICT are
      // answers too — the server has the line and the audit trail).
      this.outbox.markSent(batch.map((row) => row.id));
    }
  }

  /** One roster tick for one terminal: ask, diff, queue the difference. */
  async syncRoster(terminal: TerminalConfig): Promise<void> {
    let roster: RosterAnswer;
    try {
      roster = await this.api.call<RosterAnswer>(terminal, 'ingest/roster', {});
    } catch (error) {
      this.log(`${terminal.serial}: roster not read (${describeQuietly(error)}); will retry.`);
      return;
    }
    const known = new Map(
      this.outbox.knownUsers(terminal.serial).map((user) => [user.deviceUserRef, user]),
    );
    const listed = new Map(roster.users.map((user) => [user.deviceUserRef, user]));

    for (const [ref, user] of listed) {
      if (!known.has(ref)) {
        this.commandId += 1;
        this.outbox.queueCommand(
          terminal.serial,
          addUserCommand(this.commandId, ref, user.displayName),
        );
        this.outbox.rememberUser(terminal.serial, ref, user.displayName);
      }
    }
    for (const ref of known.keys()) {
      if (!listed.has(ref)) {
        this.commandId += 1;
        this.outbox.queueCommand(terminal.serial, deleteUserCommand(this.commandId, ref));
        this.outbox.forgetUser(terminal.serial, ref);
      }
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
