import { describe, expect, it } from 'vitest';
import {
  addUserPayload,
  deleteUserPayload,
  deviceEventIdFor,
  deviceTimeToUtc,
  parseAttendanceLine,
  parseOperationLine,
  parseUpload,
} from '../src/iclock.ts';

describe('parseAttendanceLine', () => {
  it('translates status and verify mode the way the design table says', () => {
    const punch = parseAttendanceLine('ZK1', '1042\t2026-09-29 06:01:00\t0\t1');
    expect(punch).toMatchObject({
      deviceUserRef: '1042',
      deviceTime: '2026-09-29T06:01:00.000+00:00',
      direction: 'IN',
      method: 'FINGERPRINT',
    });
    expect(parseAttendanceLine('ZK1', '1042\t2026-09-29 18:01:00\t1\t15')).toMatchObject({
      direction: 'OUT',
      method: 'FACE',
    });
    // Anything else: a person resolves the direction; the method is flagged.
    expect(parseAttendanceLine('ZK1', '1042\t2026-09-29 18:01:00\t4\t3')).toMatchObject({
      direction: 'UNKNOWN',
      method: 'PIN_FALLBACK',
    });
  });

  it('gives a resent line the same id, and a different line a different one', () => {
    const line = '1042\t2026-09-29 06:01:00\t0\t1';
    const first = parseAttendanceLine('ZK1', line);
    const again = parseAttendanceLine('ZK1', line);
    expect(first?.deviceEventId).toBe(again?.deviceEventId);
    expect(first?.deviceEventId).toMatch(/^[0-9a-f]{32}$/);
    // A different serial, user, time, status or verify is a different punch.
    expect(parseAttendanceLine('ZK2', line)?.deviceEventId).not.toBe(first?.deviceEventId);
    expect(deviceEventIdFor('ZK1', '1042', '2026-09-29 06:01:00', '1', '1')).not.toBe(
      first?.deviceEventId,
    );
  });

  it('refuses a line with no user or no readable time', () => {
    expect(parseAttendanceLine('ZK1', '\t2026-09-29 06:01:00\t0\t1')).toBeNull();
    expect(parseAttendanceLine('ZK1', '1042\tyesterday\t0\t1')).toBeNull();
    expect(parseAttendanceLine('ZK1', 'not a line at all')).toBeNull();
  });
});

describe('parseOperationLine', () => {
  it('keeps only that a finger was enrolled: who, when, which finger', () => {
    expect(parseOperationLine('OPLOG 6\t0\t2026-09-29 09:00:00\t1042\t1\t0')).toEqual({
      deviceUserRef: '1042',
      fingerIndex: 1,
      enrolledAt: '2026-09-29T09:00:00.000+00:00',
    });
  });

  it('ignores every other operation: the terminal diary is not our business', () => {
    expect(parseOperationLine('OPLOG 1\t0\t2026-09-29 09:00:00\t1042')).toBeNull();
    expect(parseOperationLine('1042\t2026-09-29 09:00:00\t0\t1')).toBeNull();
  });
});

describe('parseUpload', () => {
  it('takes Windows line endings, blank lines and broken lines in its stride', () => {
    const body =
      '1\t2026-09-29 06:00:00\t0\t1\r\n\r\nbroken line\r\n2\t2026-09-29 06:05:00\t0\t15\r\n';
    const parsed = parseUpload('ZK1', 'ATTLOG', body);
    expect(parsed.punches).toHaveLength(2);
    expect(parsed.broken).toEqual(['broken line']);
  });

  it('drops a photo table whole: never parsed, never counted, never logged', () => {
    const parsed = parseUpload('ZK1', 'ATTPHOTO', 'binary-that-must-not-be-looked-at');
    expect(parsed).toEqual({ punches: [], enrollments: [], broken: [] });
  });

  it('collects enrollment proofs from an operation upload', () => {
    const parsed = parseUpload(
      'ZK1',
      'OPERLOG',
      'OPLOG 6\t0\t2026-09-29 09:00:00\t1042\t1\t0\r\nOPLOG 4\t0\t2026-09-29 09:01:00\t0\r\n',
    );
    expect(parsed.enrollments).toHaveLength(1);
    expect(parsed.broken).toEqual([]);
  });
});

describe('deviceTimeToUtc', () => {
  it('reads the terminal clock as UTC, with the offset the API wants', () => {
    expect(deviceTimeToUtc('2026-09-29 06:01:00')).toBe('2026-09-29T06:01:00.000+00:00');
    expect(deviceTimeToUtc('2026-13-40 06:01:00')).toBeNull();
    expect(deviceTimeToUtc('')).toBeNull();
  });
});

describe('user commands', () => {
  it('writes the add and delete payloads the terminal understands', () => {
    expect(addUserPayload('1042', 'Kwame A.')).toBe('DATA USER PIN=1042\tName=Kwame A.\tPri=0');
    expect(deleteUserPayload('1042')).toBe('DATA DELETE USERINFO PIN=1042');
  });

  it('never lets a name smuggle a tab or a line break into the protocol', () => {
    expect(addUserPayload('1042', 'A\tB\r\nC')).toBe('DATA USER PIN=1042\tName=A B C\tPri=0');
  });

  it('refuses a user ref that could inject a field into the command', () => {
    // A tab in the PIN would add fields to a line the terminal executes —
    // Pri=14 is an administrator. Refs come from our API, but that is an
    // observation, not a rule.
    expect(() => addUserPayload('10\tPri=14', 'X')).toThrow(/not safe/);
    expect(() => deleteUserPayload('a'.repeat(33))).toThrow(/not safe/);
  });
});

describe('hostile lines', () => {
  it('refuses a user number the API would refuse, instead of wedging a batch', () => {
    // 33 characters: over the API's 32 limit. One such line delivered as-is
    // would 400 the whole batch it travels in, forever.
    expect(parseAttendanceLine('ZK1', `${'9'.repeat(33)}\t2026-09-29 06:00:00\t0\t1`)).toBeNull();
    expect(parseAttendanceLine('ZK1', 'user with spaces\t2026-09-29 06:00:00\t0\t1')).toBeNull();
  });

  it('refuses an impossible date instead of letting Date.parse roll it over', () => {
    // Date.parse would quietly turn February 30th into March 2nd, the text
    // then fails the API's validation, and the batch would wedge.
    expect(deviceTimeToUtc('2026-02-30 06:00:00')).toBeNull();
    expect(deviceTimeToUtc('2026-04-31 06:00:00')).toBeNull();
    expect(deviceTimeToUtc('2026-09-29 24:00:00')).toBeNull();
    expect(deviceTimeToUtc('2026-02-28 23:59:59')).toBe('2026-02-28T23:59:59.000+00:00');
  });

  it('a missing finger field is a missing finger, not finger zero', () => {
    const enrollment = parseOperationLine('OPLOG 6\t0\t2026-09-29 09:00:00\t1042\t');
    expect(enrollment).toEqual({
      deviceUserRef: '1042',
      enrolledAt: '2026-09-29T09:00:00.000+00:00',
    });
  });
});
