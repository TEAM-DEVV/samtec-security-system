import { describe, expect, it } from 'vitest';
import {
  addUserCommand,
  deleteUserCommand,
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
    expect(parsed.brokenLines).toBe(1);
  });

  it('drops a photo table whole: never parsed, never counted, never logged', () => {
    const parsed = parseUpload('ZK1', 'ATTPHOTO', 'binary-that-must-not-be-looked-at');
    expect(parsed).toEqual({ punches: [], enrollments: [], brokenLines: 0 });
  });

  it('collects enrollment proofs from an operation upload', () => {
    const parsed = parseUpload(
      'ZK1',
      'OPERLOG',
      'OPLOG 6\t0\t2026-09-29 09:00:00\t1042\t1\t0\r\nOPLOG 4\t0\t2026-09-29 09:01:00\t0\r\n',
    );
    expect(parsed.enrollments).toHaveLength(1);
    expect(parsed.brokenLines).toBe(0);
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
  it('writes the add and delete lines the terminal understands', () => {
    expect(addUserCommand(7, '1042', 'Kwame A.')).toBe(
      'C:7:DATA USER PIN=1042\tName=Kwame A.\tPri=0',
    );
    expect(deleteUserCommand(8, '1042')).toBe('C:8:DATA DELETE USERINFO PIN=1042');
  });

  it('never lets a name smuggle a tab or a line break into the protocol', () => {
    expect(addUserCommand(9, '1042', 'A\tB\r\nC')).toBe(
      'C:9:DATA USER PIN=1042\tName=A B C\tPri=0',
    );
  });
});
