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

/**
 * What a terminal user number may look like before it goes anywhere: the
 * API's own rule (printable ASCII, 1 to 32) tightened to what staff numbers
 * actually are, so a hostile line can never smuggle a tab, a newline or a
 * NUL into a stored payload or a terminal command.
 */
export const SAFE_USER_REF = /^[A-Za-z0-9-]{1,32}$/;

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
  /**
   * Lines that parsed as nothing, capped short, for the quarantine. A
   * terminal that hears `OK` never resends, so dropping a broken line
   * silently would lose whatever punch it was trying to be.
   */
  broken: string[];
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
  if (!SAFE_USER_REF.test(user) || time === null) {
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
  // A single digit, spelt out: Number('') is 0, which would invent a finger.
  const fingerText = parts[4]?.trim() ?? '';
  if (!SAFE_USER_REF.test(user) || enrolledAt === null) {
    return null;
  }
  return {
    deviceUserRef: user,
    ...(/^[0-9]$/.test(fingerText) ? { fingerIndex: Number(fingerText) } : {}),
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
  const parsed: ParsedUpload = { punches: [], enrollments: [], broken: [] };
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
        parsed.broken.push(line.slice(0, 512));
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
      parsed.broken.push(line.slice(0, 512));
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
  // Every field has to survive a real calendar. `Date.parse` quietly rolls an
  // impossible date over (2026-02-30 becomes March 2nd), the API then rejects
  // the text, and one such line could wedge a whole batch — so each field is
  // checked against what the Date actually became.
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const at = new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0),
  );
  if (
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== (month ?? 1) - 1 ||
    at.getUTCDate() !== day ||
    at.getUTCHours() !== hour ||
    at.getUTCMinutes() !== minute ||
    at.getUTCSeconds() !== second
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000+00:00`;
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

/**
 * A user command's payload, without its id: the queue's own row id becomes
 * the `C:<id>:` prefix at serve time, so the number the terminal
 * acknowledges is always the number the queue knows.
 *
 * The user ref is checked, not trusted: it is interpolated into a line the
 * terminal executes, and a tab in it would inject fields (`Pri=14` is an
 * administrator). Refs come from our own API, but "from our own API" is an
 * observation, not a rule.
 */
export function addUserPayload(deviceUserRef: string, displayName: string): string {
  if (!SAFE_USER_REF.test(deviceUserRef)) {
    throw new Error('That user number is not safe for a terminal command.');
  }
  // Privilege 0 is an ordinary user; the name is display-only on the terminal.
  return `DATA USER PIN=${deviceUserRef}	Name=${sanitised(displayName)}\tPri=0`;
}

export function deleteUserPayload(deviceUserRef: string): string {
  if (!SAFE_USER_REF.test(deviceUserRef)) {
    throw new Error('That user number is not safe for a terminal command.');
  }
  return `DATA DELETE USERINFO PIN=${deviceUserRef}`;
}

/** A name as the terminal may hold it: no tabs, no line breaks, short. */
function sanitised(name: string): string {
  // By characters, not code units, so a name never loses half an emoji.
  return Array.from(name.replace(/[\t\r\n]+/g, ' '))
    .slice(0, 24)
    .join('');
}
