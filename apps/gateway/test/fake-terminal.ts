/**
 * The fake ZKTeco terminal: it talks to the **real** gateway, which talks to
 * the **real** API — nothing in the chain is a stub except the hardware
 * (docs/plan/13 sections 5 and 7). The e2e test drives it, and it can be run
 * by hand against a local gateway for the demo:
 *
 *   pnpm --filter @samtec/gateway fake-terminal -- --gateway http://127.0.0.1:8081 --serial ZKDEMO0001
 *
 * It speaks the same subset of iClock the gateway parses: the handshake, the
 * ATTLOG and OPERLOG uploads, the command poll and the acknowledgement. When
 * a real terminal is bought, its quirks are reconciled in `src/iclock.ts` and
 * here together.
 */
import { parseArgs } from 'node:util';

export interface FakeTerminal {
  handshake: () => Promise<string>;
  /** Uploads raw lines to one table and returns the gateway's answer. */
  upload: (table: string, lines: string[]) => Promise<string>;
  /** Uploads `count` clock-ins spread over a morning, in one body. */
  uploadPunchBurst: (count: number, day?: string) => Promise<string>;
  /** Polls for one command; `OK` means the queue is empty. */
  pollCommand: () => Promise<string>;
  acknowledge: (commandId: number) => Promise<string>;
}

/** A terminal at `gateway`, claiming `serial`. */
export function fakeTerminal(gateway: string, serial: string): FakeTerminal {
  const base = gateway.replace(/\/+$/, '');
  const ask = async (path: string, body?: string): Promise<string> => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body }),
    });
    return `${response.status} ${await response.text()}`;
  };
  return {
    handshake: () => ask(`/iclock/cdata?SN=${serial}&options=all`),
    upload: (table, lines) =>
      // Windows line endings on purpose: that is what the hardware sends.
      ask(`/iclock/cdata?SN=${serial}&table=${table}&Stamp=9999`, `${lines.join('\r\n')}\r\n`),
    uploadPunchBurst: (count, day = '2026-09-29') => {
      const lines = Array.from({ length: count }, (_unused, index) => {
        const minute = String(index % 60).padStart(2, '0');
        const hour = String(6 + Math.floor(index / 60)).padStart(2, '0');
        // user, time, status (0 = in), verify (1 = fingerprint)
        return `${1000 + index}\t${day} ${hour}:${minute}:00\t0\t1`;
      });
      return ask(`/iclock/cdata?SN=${serial}&table=ATTLOG&Stamp=9999`, `${lines.join('\r\n')}\r\n`);
    },
    pollCommand: () => ask(`/iclock/getrequest?SN=${serial}`),
    acknowledge: (commandId) =>
      ask(`/iclock/devicecmd?SN=${serial}`, `ID=${commandId}&Return=0&CMD=DATA`),
  };
}

/** A finger-enrollment operation line, as the terminal would report it. */
export function enrollmentLine(user: string, time: string, finger = 1): string {
  return `OPLOG 6\t0\t${time}\t${user}\t${finger}\t0`;
}

// Run by hand: a short believable morning against a local gateway.
if (process.argv[1]?.endsWith('fake-terminal.ts')) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      gateway: { type: 'string', default: 'http://127.0.0.1:8081' },
      serial: { type: 'string', default: 'ZKDEMO0001' },
      punches: { type: 'string', default: '10' },
    },
  });
  const terminal = fakeTerminal(values.gateway ?? '', values.serial ?? '');
  console.log('handshake:', await terminal.handshake());
  console.log('burst:    ', await terminal.uploadPunchBurst(Number(values.punches)));
  console.log('resend:   ', await terminal.uploadPunchBurst(Number(values.punches)));
  console.log('command:  ', await terminal.pollCommand());
}
