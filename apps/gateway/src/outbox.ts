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
 * `node:sqlite`, no dependency: one file, transactional, on the mini PC's own
 * disk. Rows are kept after sending (marked, not deleted) for fourteen days,
 * so "what did this terminal claim?" can be answered from the site itself.
 */
import { DatabaseSync } from 'node:sqlite';
import type { TranslatedEnrollment, TranslatedPunch } from './iclock.ts';

/** The API's batch limit: at most 100 punches in one signed request. */
export const BATCH_LIMIT = 100;
/** Sent rows older than this are swept. Two weeks answers any dispute. */
const KEEP_SENT_DAYS = 14;

export interface OutboxRow {
  id: number;
  serial: string;
  kind: 'PUNCH' | 'ENROLLMENT';
  /** The translated line, exactly as it will be sent. */
  payload: string;
}

export class Outbox {
  private readonly db: DatabaseSync;

  /** `:memory:` in tests; a real file path on a real gateway. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        serial   TEXT    NOT NULL,
        kind     TEXT    NOT NULL CHECK (kind IN ('PUNCH', 'ENROLLMENT')),
        event_id TEXT    NOT NULL,
        payload  TEXT    NOT NULL,
        sent_at  TEXT,
        stored_at TEXT   NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_once
        ON outbox (serial, kind, event_id);
      CREATE INDEX IF NOT EXISTS outbox_unsent
        ON outbox (serial, kind, id) WHERE sent_at IS NULL;
      CREATE TABLE IF NOT EXISTS commands (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        serial   TEXT    NOT NULL,
        line     TEXT    NOT NULL,
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

  /** Who this terminal has been told about, for the roster diff. */
  knownUsers(serial: string): { deviceUserRef: string; displayName: string }[] {
    return this.db
      .prepare(
        `SELECT device_user_ref AS deviceUserRef, display_name AS displayName
         FROM terminal_users WHERE serial = ? ORDER BY device_user_ref`,
      )
      .all(serial) as unknown as { deviceUserRef: string; displayName: string }[];
  }

  rememberUser(serial: string, deviceUserRef: string, displayName: string): void {
    this.db
      .prepare(
        `INSERT INTO terminal_users (serial, device_user_ref, display_name) VALUES (?, ?, ?)
         ON CONFLICT (serial, device_user_ref) DO UPDATE SET display_name = excluded.display_name`,
      )
      .run(serial, deviceUserRef, displayName);
  }

  forgetUser(serial: string, deviceUserRef: string): void {
    this.db
      .prepare(`DELETE FROM terminal_users WHERE serial = ? AND device_user_ref = ?`)
      .run(serial, deviceUserRef);
  }

  /**
   * Stores one upload's lines, inside one transaction, and returns only when
   * they are on disk. The caller answers the terminal `OK` **after** this. A
   * line stored before (a resend) is left as it was — sent or not — so a
   * resend can never make a punch deliverable twice from here.
   */
  store(serial: string, punches: TranslatedPunch[], enrollments: TranslatedEnrollment[]): void {
    const insert = this.db.prepare(
      `INSERT INTO outbox (serial, kind, event_id, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT (serial, kind, event_id) DO NOTHING`,
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The oldest unsent rows of one kind for one terminal, oldest first. */
  nextBatch(serial: string, kind: OutboxRow['kind'], limit = BATCH_LIMIT): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, serial, kind, payload FROM outbox
         WHERE serial = ? AND kind = ? AND sent_at IS NULL
         ORDER BY id LIMIT ?`,
      )
      .all(serial, kind, limit) as unknown as OutboxRow[];
    return rows;
  }

  /** Marks rows delivered — only after the API answered for them. */
  markSent(ids: number[]): void {
    const mark = this.db.prepare(
      `UPDATE outbox SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    );
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
      .prepare(`SELECT COUNT(*) AS waiting FROM outbox WHERE sent_at IS NULL`)
      .get() as { waiting: number } | undefined;
    return row?.waiting ?? 0;
  }

  /** Sweeps sent rows older than two weeks. Unsent rows are never swept. */
  sweep(): void {
    this.db
      .prepare(
        `DELETE FROM outbox
         WHERE sent_at IS NOT NULL AND stored_at < datetime('now', ?)`,
      )
      .run(`-${KEEP_SENT_DAYS} days`);
  }

  /** Queues one command line for a terminal, unless it is already waiting. */
  queueCommand(serial: string, line: string): void {
    const waiting = this.db
      .prepare(`SELECT 1 FROM commands WHERE serial = ? AND line = ? AND done_at IS NULL`)
      .get(serial, line);
    if (waiting === undefined) {
      this.db.prepare(`INSERT INTO commands (serial, line) VALUES (?, ?)`).run(serial, line);
    }
  }

  /**
   * The next command for a terminal's poll, marked served so a slow terminal
   * is not handed the same command twice; it stays open until acknowledged.
   */
  nextCommand(serial: string): { id: number; line: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, line FROM commands
         WHERE serial = ? AND done_at IS NULL AND (served_at IS NULL
           OR served_at < datetime('now', '-5 minutes'))
         ORDER BY id LIMIT 1`,
      )
      .get(serial) as { id: number; line: string } | undefined;
    if (row === undefined) {
      return null;
    }
    this.db
      .prepare(`UPDATE commands SET served_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(row.id);
    return row;
  }

  /** The terminal acknowledged a command. */
  finishCommand(id: number): void {
    this.db
      .prepare(`UPDATE commands SET done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(id);
  }

  close(): void {
    this.db.close();
  }
}
