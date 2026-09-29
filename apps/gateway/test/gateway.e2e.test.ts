import { createServer, type Server } from 'node:http';
import { DEVICE_SIGNATURE_VECTOR } from '@samtec/contracts/device-signature-vector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayApi } from '../src/api.ts';
import { checkedConfig, type GatewayConfig } from '../src/config.ts';
import { Delivery } from '../src/delivery.ts';
import { Outbox } from '../src/outbox.ts';
import { type GatewayServer, startServer } from '../src/server.ts';
import { signRequest } from '../src/signing.ts';
import { enrollmentLine, fakeTerminal } from './fake-terminal.ts';

/**
 * The whole chain minus the hardware and the real API: the fake terminal
 * drives the real gateway over real HTTP, and the gateway delivers to a
 * pretend API that records exactly what it was sent. Everything the design's
 * section 5 promises about delivery is asserted here at size.
 */

describe('the shared signature vector', () => {
  it('is produced by this third implementation too', () => {
    const { secret, timestamp, route, body, signature } = DEVICE_SIGNATURE_VECTOR;
    expect(signRequest(secret, timestamp, route as never, body)).toBe(signature);
  });
});

/** The pretend API: every signed request, kept for the assertions. */
interface ApiCall {
  route: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

let apiServer: Server;
let apiCalls: ApiCall[];
let apiAnswer: (route: string) => { status: number; body: unknown };
let gateway: GatewayServer;
let outbox: Outbox;
let config: GatewayConfig;
let delivery: Delivery;
let logged: string[];
let theTerminal: import('../src/config.ts').TerminalConfig;

const SERIAL = 'ZKTEST0001';
const SECRET = 'sk_test_gateway_terminal_secret';

beforeEach(async () => {
  apiCalls = [];
  apiAnswer = () => ({ status: 200, body: { results: [] } });
  apiServer = createServer((request, response) => {
    const pieces: Buffer[] = [];
    request.on('data', (piece: Buffer) => pieces.push(piece));
    request.on('end', () => {
      const route = (request.url ?? '').replace(/^\//, '');
      const bodyText = Buffer.concat(pieces).toString('utf8');
      apiCalls.push({
        route,
        headers: {
          device: request.headers['x-samtec-device'] as string | undefined,
          timestamp: request.headers['x-samtec-timestamp'] as string | undefined,
          signature: request.headers['x-samtec-signature'] as string | undefined,
        },
        body: bodyText === '' ? null : JSON.parse(bodyText),
      });
      const answer = apiAnswer(route);
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiPort = (apiServer.address() as { port: number }).port;

  config = checkedConfig({
    apiUrl: `http://127.0.0.1:${apiPort}`,
    port: 0,
    outboxFile: ':memory:',
    terminals: [
      {
        serial: SERIAL,
        allowedIps: ['127.0.0.1'],
        deviceId: '01927c3e-9999-7aaa-8bbb-0c0c0c0c0c99',
        secret: SECRET,
      },
    ],
  });
  theTerminal = config.terminals[0] as import('../src/config.ts').TerminalConfig;
  outbox = new Outbox(':memory:');
  logged = [];
  delivery = new Delivery(new GatewayApi(config.apiUrl), outbox, (line) => logged.push(line));
  gateway = await startServer(config, outbox, (line) => logged.push(line));
});

afterEach(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  outbox.close();
});

function terminal() {
  return fakeTerminal(`http://127.0.0.1:${gateway.port()}`, SERIAL);
}

describe('the door', () => {
  it('answers the handshake with real-time mode, UTC and no photos', async () => {
    const answer = await terminal().handshake();
    expect(answer).toContain('200 ');
    expect(answer).toContain('Realtime=1');
    expect(answer).toContain('TimeZone=0');
    expect(answer).not.toMatch(/photo=1/i);
  });

  it('refuses an unknown serial with one word that names nothing', async () => {
    const stranger = fakeTerminal(`http://127.0.0.1:${gateway.port()}`, 'ZKUNKNOWN');
    expect(await stranger.handshake()).toBe('403 DENIED');
    expect(await stranger.uploadPunchBurst(3)).toBe('403 DENIED');
  });
});

describe('the outbox promise', () => {
  it('has the lines on disk before the terminal hears OK', async () => {
    const answer = await terminal().uploadPunchBurst(3);
    expect(answer).toBe('200 OK: 3');
    // Nothing has been pumped yet — the rows exist because of the upload alone.
    expect(outbox.unsentCount()).toBe(3);
  });

  it('a resent day changes nothing: the same lines are the same rows', async () => {
    await terminal().uploadPunchBurst(50);
    await terminal().uploadPunchBurst(50);
    expect(outbox.unsentCount()).toBe(50);
  });

  it('a broken line is dropped and counted, never stored', async () => {
    await terminal().upload('ATTLOG', ['1042\t2026-09-29 06:00:00\t0\t1', 'garbage']);
    expect(outbox.unsentCount()).toBe(1);
    expect(logged.some((line) => line.includes('1 line(s)'))).toBe(true);
  });

  it('a photo upload is dropped whole, without a word about its contents', async () => {
    const answer = await terminal().upload('ATTPHOTO', ['jpeg-bytes-pretend']);
    expect(answer).toBe('200 OK: 0');
    expect(outbox.unsentCount()).toBe(0);
    expect(logged.join('\n')).not.toContain('jpeg');
  });
});

describe('delivery', () => {
  it('sends 500 lines as 5 signed batches of 100, oldest first', async () => {
    await terminal().uploadPunchBurst(500);
    await delivery.pump(theTerminal);

    const punchCalls = apiCalls.filter((call) => call.route === 'ingest/punches');
    expect(punchCalls).toHaveLength(5);
    for (const call of punchCalls) {
      expect((call.body as { punches: unknown[] }).punches).toHaveLength(100);
      expect(call.headers.device).toBe('01927c3e-9999-7aaa-8bbb-0c0c0c0c0c99');
      expect(call.headers.signature).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(outbox.unsentCount()).toBe(0);
    // Pumping again sends nothing: everything is marked.
    await delivery.pump(theTerminal);
    expect(apiCalls.filter((call) => call.route === 'ingest/punches')).toHaveLength(5);
  });

  it('leaves the rows where they are when the API is down, and retries', async () => {
    await terminal().uploadPunchBurst(10);
    apiAnswer = () => ({ status: 503, body: { title: 'busy', status: 503 } });
    await delivery.pump(theTerminal);
    expect(outbox.unsentCount()).toBe(10);

    apiAnswer = () => ({ status: 200, body: { results: [] } });
    await delivery.pump(theTerminal);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('raises one loud alarm on a 401 and never quietly drops the rows', async () => {
    await terminal().uploadPunchBurst(10);
    apiAnswer = () => ({ status: 401, body: { title: 'unauthorized', status: 401 } });
    await delivery.pump(theTerminal);
    await delivery.pump(theTerminal);

    const alarms = logged.filter((line) => line.startsWith('ALARM'));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain('switched off');
    expect(outbox.unsentCount()).toBe(10);
  });

  it('forwards an enrollment proof, and never a template', async () => {
    await terminal().upload('OPERLOG', [enrollmentLine('1042', '2026-09-29 09:00:00', 2)]);
    await delivery.pump(theTerminal);

    const call = apiCalls.find((made) => made.route === 'ingest/enrollments');
    expect(call?.body).toEqual({
      enrollments: [
        { deviceUserRef: '1042', fingerIndex: 2, enrolledAt: '2026-09-29T09:00:00.000+00:00' },
      ],
    });
  });
});

describe('the roster and the command queue', () => {
  it('adds who the roster names, removes who it no longer names, and serves the commands', async () => {
    apiAnswer = (route) =>
      route === 'ingest/roster'
        ? {
            status: 200,
            body: {
              users: [{ deviceUserRef: '1042', staffNumber: 'SMT-01042', displayName: 'Kwame A.' }],
              serverTime: '2026-09-29T10:00:00.000Z',
            },
          }
        : { status: 200, body: { results: [] } };
    await delivery.syncRoster(theTerminal);

    // The terminal polls and is told about Kwame, once.
    const served = await terminal().pollCommand();
    expect(served).toContain('DATA USER PIN=1042');
    expect(served).toContain('Name=Kwame A.');
    const commandId = Number(/C:(\d+):/.exec(served)?.[1]);
    await terminal().acknowledge(commandId);
    expect(await terminal().pollCommand()).toBe('200 OK');

    // A repeated roster queues nothing new: it is safe to repeat.
    await delivery.syncRoster(theTerminal);
    expect(await terminal().pollCommand()).toBe('200 OK');

    // Kwame leaves the roster (blocked as a duplicate, say): removed.
    apiAnswer = (route) =>
      route === 'ingest/roster'
        ? { status: 200, body: { users: [], serverTime: '2026-09-29T10:05:00.000Z' } }
        : { status: 200, body: { results: [] } };
    await delivery.syncRoster(theTerminal);
    expect(await terminal().pollCommand()).toContain('DELETE USERINFO PIN=1042');
  });
});
