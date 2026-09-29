/**
 * The outbox: why a terminal's `OK` can be trusted.
 *
 * A line is written **here, on disk, before the terminal hears `OK`** — that
 * ordering is the delivery promise of the whole gateway (docs/plan/13
 * section 5). Once a terminal hears `OK` it will never resend the line, so an
 * `OK` for a line that only lived in memory would quietly lose a punch, which
 * is a person quietly not being paid. The power can fail *after* the `OK`;
 * the outbox survives it, and the pump sends what is left on the next start.
 *
 * The same reasoning gives the **quarantine**: a line that cannot be read is
 * still a line the terminal will never resend, so it is kept (capped short)
 * rather than dropped, and a **rejected** row — one the API refused as
 * malformed — is kept and marked rather than retried forever or deleted.
 *
 * `node:sqlite`, no dependency: one file, transactional, on the mini PC's own
 * disk. Rows are kept after sending (marked, not deleted) for fourteen days,
 * so "what did this terminal claim?" can be answered from the site itself.
 *
 * Every timestamp this file writes or compares uses one format,
 * `strftime('%Y-%m-%dT%H:%M:%fZ')`. SQLite compares these as text, and
 * `datetime('now')` prints a space where this prints a `T` — mixing the two
 * made a five-minute comparison into a once-a-day one.
 */
import { DatabaseSync } from 'node:sqlite';
import type { TranslatedEnrollment, TranslatedPunch } from './iclock.ts';

/** The API's batch limit: at most 100 punches in one signed request. */
export const BATCH_LIMIT = 100;
/** Sent rows older than this are swept. Two weeks answers any dispute. */
const KEEP_SENT_DAYS = 14;
/** The one timestamp format, as a SQL fragment. */
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export interface OutboxRow {
  id: number;
  serial: string;
  kind: 'PUNCH' | 'ENROLLMENT';
  /** The translated line, exactly as it will be sent. */
  payload: string;
}

/** A command as the terminal is served it, `C:<row id>:<payload>`. */
export interface ServedCommand {
  id: number;
  line: string;
}

export class Outbox {
  private readonly db: DatabaseSync;

  /** `:memory:` in tests; a real file path on a real gateway. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // A second reader (somebody inspecting the file) must wait, not error.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        serial      TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK (kind IN ('PUNCH', 'ENROLLMENT')),
        event_id    TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        sent_at     TEXT,
        rejected_at TEXT,
        stored_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_once
        ON outbox (serial, kind, event_id);
      CREATE INDEX IF NOT EXISTS outbox_unsent
        ON outbox (serial, kind, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
      CREATE TABLE IF NOT EXISTS quarantine (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        serial    TEXT NOT NULL,
        table_name TEXT NOT NULL,
        line      TEXT NOT NULL,
        stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS commands (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        serial    TEXT NOT NULL,
        kind      TEXT NOT NULL CHECK (kind IN ('ADD', 'DELETE')),
        ref       TEXT NOT NULL,
        name      TEXT NOT NULL DEFAULT '',
        payload   TEXT NOT NULL,
        served_at TEXT,
        done_at   TEXT
      );
      CREATE TABLE IF NOT EXISTS terminal_users (
        serial          TEXT NOT NULL,
        device_user_ref TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        PRIMARY KEY (serial, device_user_ref)
      );
    `);
  }

  /**
   * Stores one upload's lines — the readable and the broken alike — inside
   * one transaction, and returns only when they are on disk. The caller
   * answers the terminal `OK` **after** this. A line stored before (a resend)
   * is left as it was — sent, rejected or waiting — so a resend can never
   * make a punch deliverable twice from here.
   */
  store(
    serial: string,
    punches: TranslatedPunch[],
    enrollments: TranslatedEnrollment[],
    broken: string[] = [],
    tableName = 'ATTLOG',
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO outbox (serial, kind, event_id, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT (serial, kind, event_id) DO NOTHING`,
    );
    const keep = this.db.prepare(
      `INSERT INTO quarantine (serial, table_name, line) VALUES (?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const punch of punches) {
        insert.run(serial, 'PUNCH', punch.deviceEventId, JSON.stringify(punch));
      }
      for (const enrollment of enrollments) {
        // An enrollment has no device id of its own; user and moment name it.
        insert.run(
          serial,
          'ENROLLMENT',
          `${enrollment.deviceUserRef}@${enrollment.enrolledAt}`,
          JSON.stringify(enrollment),
        );
      }
      for (const line of broken) {
        keep.run(serial, tableName, line.slice(0, 512));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The oldest waiting rows of one kind for one terminal, oldest first. */
  nextBatch(serial: string, kind: OutboxRow['kind'], limit = BATCH_LIMIT): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, serial, kind, payload FROM outbox
         WHERE serial = ? AND kind = ? AND sent_at IS NULL AND rejected_at IS NULL
         ORDER BY id LIMIT ?`,
      )
      .all(serial, kind, limit) as unknown as OutboxRow[];
    return rows;
  }

  /** Marks rows delivered — only after the API answered for those rows. */
  markSent(ids: number[]): void {
    this.markColumn(ids, 'sent_at');
  }

  /**
   * Marks rows the API refused as malformed. Kept, never deleted: a rejected
   * row is evidence of what a terminal sent, and retrying it forever would
   * wedge every later punch behind it.
   */
  markRejected(ids: number[]): void {
    this.markColumn(ids, 'rejected_at');
  }

  private markColumn(ids: number[], column: 'sent_at' | 'rejected_at'): void {
    const mark = this.db.prepare(`UPDATE outbox SET ${column} = ${NOW} WHERE id = ?`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        mark.run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** How many rows still wait, which is the number a health line reports. */
  unsentCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS waiting FROM outbox WHERE sent_at IS NULL AND rejected_at IS NULL`,
      )
      .get() as { waiting: number } | undefined;
    return row?.waiting ?? 0;
  }

  /** Rejected and quarantined counts, for the health line and the log. */
  troubleCounts(): { rejected: number; quarantined: number } {
    const rejected = this.db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE rejected_at IS NOT NULL`)
      .get() as { n: number };
    const quarantined = this.db.prepare(`SELECT COUNT(*) AS n FROM quarantine`).get() as {
      n: number;
    };
    return { rejected: rejected.n, quarantined: quarantined.n };
  }

  /**
   * Sweeps rows **sent** more than two weeks ago — the clock starts when the
   * API took them, not when they were stored. Unsent, rejected and
   * quarantined rows are never swept: each is evidence of something.
   */
  sweep(): void {
    this.db
      .prepare(
        `DELETE FROM outbox
         WHERE sent_at IS NOT NULL
           AND sent_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
      )
      .run(`-${KEEP_SENT_DAYS} days`);
  }

  /**
   * Queues one user command, unless the same job is already open. The
   * payload is stored without its `C:<id>:` prefix — the row id becomes the
   * prefix at serve time, so the id the terminal acknowledges is always the
   * id this table knows.
   */
  queueCommand(
    serial: string,
    kind: 'ADD' | 'DELETE',
    ref: string,
    name: string,
    payload: string,
  ): void {
    const waiting = this.db
      .prepare(
        `SELECT 1 FROM commands
         WHERE serial = ? AND kind = ? AND ref = ? AND done_at IS NULL`,
      )
      .get(serial, kind, ref);
    if (waiting === undefined) {
      this.db
        .prepare(`INSERT INTO commands (serial, kind, ref, name, payload) VALUES (?, ?, ?, ?, ?)`)
        .run(serial, kind, ref, name, payload);
    }
  }

  /** Whether this job is already queued or acknowledged, for the roster diff. */
  commandOpen(serial: string, kind: 'ADD' | 'DELETE', ref: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM commands WHERE serial = ? AND kind = ? AND ref = ? AND done_at IS NULL`,
        )
        .get(serial, kind, ref) !== undefined
    );
  }

  /**
   * The next command for a terminal's poll, marked served so a slow terminal
   * is not handed the same command twice in a row; an unacknowledged command
   * is offered again after five minutes.
   */
  nextCommand(serial: string): ServedCommand | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM commands
         WHERE serial = ? AND done_at IS NULL AND (served_at IS NULL
           OR served_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))
         ORDER BY id LIMIT 1`,
      )
      .get(serial) as { id: number; payload: string } | undefined;
    if (row === undefined) {
      return null;
    }
    this.db.prepare(`UPDATE commands SET served_at = ${NOW} WHERE id = ?`).run(row.id);
    return { id: row.id, line: `C:${row.id}:${row.payload}` };
  }

  /**
   * The terminal answered a command — **its own** command: the serial is part
   * of the key, so one terminal can never close another's job. Only a
   * successful answer updates what the terminal is known to hold; a failure
   * reopens the job so the next roster tick queues nothing new and the next
   * poll serves it again.
   */
  finishCommand(serial: string, id: number, succeeded: boolean): void {
    const row = this.db
      .prepare(
        `SELECT kind, ref, name FROM commands WHERE id = ? AND serial = ? AND done_at IS NULL`,
      )
      .get(id, serial) as { kind: 'ADD' | 'DELETE'; ref: string; name: string } | undefined;
    if (row === undefined) {
      return;
    }
    if (!succeeded) {
      // Served again after the five-minute wait, and visible in the log.
      this.db.prepare(`UPDATE commands SET served_at = NULL WHERE id = ?`).run(id);
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE commands SET done_at = ${NOW} WHERE id = ?`).run(id);
      if (row.kind === 'ADD') {
        this.db
          .prepare(
            `INSERT INTO terminal_users (serial, device_user_ref, display_name) VALUES (?, ?, ?)
             ON CONFLICT (serial, device_user_ref) DO UPDATE SET display_name = excluded.display_name`,
          )
          .run(serial, row.ref, row.name);
      } else {
        this.db
          .prepare(`DELETE FROM terminal_users WHERE serial = ? AND device_user_ref = ?`)
          .run(serial, row.ref);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Who this terminal has **acknowledged** holding, for the roster diff. */
  knownUsers(serial: string): { deviceUserRef: string; displayName: string }[] {
    return this.db
      .prepare(
        `SELECT device_user_ref AS deviceUserRef, display_name AS displayName
         FROM terminal_users WHERE serial = ? ORDER BY device_user_ref`,
      )
      .all(serial) as unknown as { deviceUserRef: string; displayName: string }[];
  }

  close(): void {
    this.db.close();
  }
}
