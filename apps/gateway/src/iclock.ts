/**
 * The terminal's language, as pure rules: bytes from a ZKTeco terminal in,
 * punches and enrollment reports out. Nothing here touches the network, the
 * database or the clock, which is why every rule in this file has a test.
 *
 * ZKTeco terminals speak "iClock": plain HTTP where the terminal is the
 * client. It POSTs its attendance and operation logs as tab-separated text
 * lines, GETs a command queue, and expects short plain-text answers. This file
 * implements the subset the design needs (docs/plan/13-biometrics-design.md
 * section 5), matched to the fake terminal that drives the tests. **When a
 * real terminal is bought, its firmware's quirks are reconciled here and in
 * the fake terminal together** — the point of keeping the translation pure is
 * that reconciling it never touches delivery or the outbox.
 */
import { createHash } from 'node:crypto';

/** One attendance line, translated to the API's language. */
export interface TranslatedPunch {
  deviceEventId: string;
  deviceUserRef: string;
  /** The device time read as UTC, ISO-formatted with the +00:00 the API wants. */
  deviceTime: string;
  direction: 'IN' | 'OUT' | 'UNKNOWN';
  method: 'FINGERPRINT' | 'FACE' | 'PIN_FALLBACK';
}

/** One "user N enrolled a finger" report. The template itself is never kept. */
export interface TranslatedEnrollment {
  deviceUserRef: string;
  fingerIndex?: number;
  enrolledAt: string;
}

/** What one uploaded body came to. Photos are dropped without being counted. */
export interface ParsedUpload {
  punches: TranslatedPunch[];
  enrollments: TranslatedEnrollment[];
  /** Lines that parsed as nothing. Counted, never stored: they may be anything. */
  brokenLines: number;
}

/**
 * The terminal's own ID for a punch: 32 hex characters of SHA-256 over
 * everything that makes the line itself. A resent line — terminals resend
 * whole days after an outage — therefore becomes the same punch, and the
 * API's `DUPLICATE` answer makes the resend harmless (docs/plan/12).
 */
export function deviceEventIdFor(
  serial: string,
  user: string,
  time: string,
  status: string,
  verify: string,
): string {
  return createHash('sha256')
    .update(`${serial}\n${user}\n${time}\n${status}\n${verify}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * One ATTLOG line: `user<TAB>time<TAB>status<TAB>verify[<TAB>…]`.
 *
 * - status: `0` → IN, `1` → OUT, anything else → UNKNOWN (a person resolves it);
 * - verify: `1` → FINGERPRINT, `15` → FACE, anything else → PIN_FALLBACK — the
 *   flagged method, because a code typed at a terminal proves possession of a
 *   code, not presence of a person.
 */
export function parseAttendanceLine(serial: string, line: string): TranslatedPunch | null {
  const parts = line.split('\t');
  const user = parts[0]?.trim() ?? '';
  const time = deviceTimeToUtc(parts[1]?.trim() ?? '');
  const status = parts[2]?.trim() ?? '';
  const verify = parts[3]?.trim() ?? '';
  if (user === '' || time === null) {
    return null;
  }
  return {
    deviceEventId: deviceEventIdFor(serial, user, parts[1]?.trim() ?? '', status, verify),
    deviceUserRef: user,
    deviceTime: time,
    direction: status === '0' ? 'IN' : status === '1' ? 'OUT' : 'UNKNOWN',
    method: verify === '1' ? 'FINGERPRINT' : verify === '15' ? 'FACE' : 'PIN_FALLBACK',
  };
}

/**
 * One OPERLOG line. The only one that matters is a finger being enrolled:
 * `OPLOG 6<TAB>admin<TAB>time<TAB>user<TAB>finger[<TAB>…]` — and all that
 * leaves this function is *that* it happened, to whom, and when. Every other
 * operation line is the terminal's own diary and is ignored.
 */
export function parseOperationLine(line: string): TranslatedEnrollment | null {
  const parts = line.split('\t');
  const first = parts[0]?.trim() ?? '';
  if (!first.startsWith('OPLOG')) {
    return null;
  }
  const operation = first.slice('OPLOG'.length).trim();
  if (operation !== '6') {
    return null;
  }
  const enrolledAt = deviceTimeToUtc(parts[2]?.trim() ?? '');
  const user = parts[3]?.trim() ?? '';
  const finger = Number(parts[4]?.trim());
  if (user === '' || enrolledAt === null) {
    return null;
  }
  return {
    deviceUserRef: user,
    ...(Number.isInteger(finger) && finger >= 0 && finger <= 9 ? { fingerIndex: finger } : {}),
    enrolledAt,
  };
}

/**
 * One uploaded body, whichever table it claims. Windows line endings and blank
 * lines are the normal case, not an error. A photo table is dropped whole:
 * never parsed, never logged — rule 8 says no biometric images, and a log line
 * would be a copy.
 */
export function parseUpload(serial: string, table: string, body: string): ParsedUpload {
  const parsed: ParsedUpload = { punches: [], enrollments: [], brokenLines: 0 };
  if (table === 'ATTPHOTO' || table === 'BIOPHOTO' || table === 'BIODATA') {
    return parsed;
  }
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '') {
      continue;
    }
    if (table === 'ATTLOG') {
      const punch = parseAttendanceLine(serial, line);
      if (punch === null) {
        parsed.brokenLines += 1;
      } else {
        parsed.punches.push(punch);
      }
    } else if (table === 'OPERLOG') {
      const enrollment = parseOperationLine(line);
      if (enrollment !== null) {
        parsed.enrollments.push(enrollment);
      }
      // Other operation lines are the terminal's diary: not broken, not kept.
    } else {
      parsed.brokenLines += 1;
    }
  }
  return parsed;
}

/**
 * The terminal's own clock, read as UTC (docs/plan/13 section 5: the handshake
 * sets the terminal to UTC, and the server measures the drift regardless).
 * `null` when the field is not a time at all.
 */
export function deviceTimeToUtc(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (match === null) {
    return null;
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000+00:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The handshake answer: real-time uploads, UTC, and **no photos**. The stamps
 * tell the terminal where its uploads reached, so a restart resends only what
 * the outbox has not already made safe.
 */
export function handshakeReply(serial: string): string {
  return [
    `GET OPTION FROM: ${serial}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=None',
    'ATTPHOTOStamp=None',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:00',
    'TransInterval=1',
    'TransFlag=TransData AttLog OpLog',
    'TimeZone=0',
    'Realtime=1',
    'Encrypt=None',
  ].join('\n');
}

/** A user command for the terminal's queue, in the terminal's own words. */
export function addUserCommand(id: number, deviceUserRef: string, displayName: string): string {
  // Privilege 0 is an ordinary user; the name is display-only on the terminal.
  return `C:${id}:DATA USER PIN=${deviceUserRef}\tName=${sanitised(displayName)}\tPri=0`;
}

export function deleteUserCommand(id: number, deviceUserRef: string): string {
  return `C:${id}:DATA DELETE USERINFO PIN=${deviceUserRef}`;
}

/** A name as the terminal may hold it: no tabs, no line breaks, short. */
function sanitised(name: string): string {
  return name.replace(/[\t\r\n]+/g, ' ').slice(0, 24);
}
