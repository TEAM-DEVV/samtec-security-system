import { createServer, type Server } from 'node:http';
import { DEVICE_SIGNATURE_VECTOR } from '@samtec/contracts/device-signature-vector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayApi } from '../src/api.ts';
import { checkedConfig, type GatewayConfig, type TerminalConfig } from '../src/config.ts';
import { Delivery } from '../src/delivery.ts';
import { Outbox } from '../src/outbox.ts';
import { type GatewayServer, startServer } from '../src/server.ts';
import { signRequest } from '../src/signing.ts';
import { enrollmentLine, fakeTerminal } from './fake-terminal.ts';

/**
 * The whole chain minus the hardware and the real API: the fake terminal
 * drives the real gateway over real HTTP, and the gateway delivers to a
 * pretend API that answers the way the real one does — **naming every row it
 * accepted** — and records exactly what it was sent. Everything the design's
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
/** What the pretend API answers. The default behaves like the real one. */
let apiAnswer: (route: string, body: unknown) => { status: number; body: unknown };
let gateway: GatewayServer;
let outbox: Outbox;
let config: GatewayConfig;
let theTerminal: TerminalConfig;
let delivery: Delivery;
let logged: string[];

const SERIAL = 'ZKTEST0001';
const SECRET = 'sk_test_gateway_terminal_secret';

/** Answers the way the real API does: every row named, status ACCEPTED. */
function honestAnswer(route: string, body: unknown): { status: number; body: unknown } {
  if (route === 'ingest/punches') {
    const { punches } = body as { punches: { deviceEventId: string }[] };
    return {
      status: 200,
      body: {
        results: punches.map((punch) => ({
          deviceEventId: punch.deviceEventId,
          status: 'ACCEPTED',
          punchId: '01927c3e-aaaa-7000-8000-000000000009',
        })),
      },
    };
  }
  if (route === 'ingest/enrollments') {
    const { enrollments } = body as {
      enrollments: { deviceUserRef: string; enrolledAt: string }[];
    };
    return {
      status: 200,
      body: {
        results: enrollments.map((one) => ({
          deviceUserRef: one.deviceUserRef,
          enrolledAt: one.enrolledAt,
          status: 'ACTIVE',
        })),
      },
    };
  }
  if (route === 'ingest/roster') {
    return { status: 200, body: { users: [], serverTime: '2026-09-29T10:00:00.000Z' } };
  }
  return { status: 200, body: {} };
}

beforeEach(async () => {
  apiCalls = [];
  apiAnswer = honestAnswer;
  apiServer = createServer((request, response) => {
    const pieces: Buffer[] = [];
    request.on('data', (piece: Buffer) => pieces.push(piece));
    request.on('end', () => {
      const route = (request.url ?? '').replace(/^\//, '');
      const bodyText = Buffer.concat(pieces).toString('utf8');
      const body: unknown = bodyText === '' ? null : JSON.parse(bodyText);
      apiCalls.push({
        route,
        headers: {
          device: request.headers['x-samtec-device'] as string | undefined,
          timestamp: request.headers['x-samtec-timestamp'] as string | undefined,
          signature: request.headers['x-samtec-signature'] as string | undefined,
        },
        body,
      });
      const answer = apiAnswer(route, body);
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
  theTerminal = config.terminals[0] as TerminalConfig;
  outbox = new Outbox(':memory:');
  logged = [];
  delivery = new Delivery(new GatewayApi(config.apiUrl), outbox, (line) => logged.push(line));
  gateway = await startServer(
    config,
    outbox,
    (line) => logged.push(line),
    () => delivery.alarmedSerials(),
  );
});

afterEach(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  outbox.close();
});

function terminal() {
  return fakeTerminal(`http://127.0.0.1:${gateway.port()}`, SERIAL);
}

function servedId(served: string): number {
  return Number(/C:(\d+):/.exec(served)?.[1]);
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

  it('requires the comm key when configured — leaving it out is not a way around it', async () => {
    await gateway.close();
    theTerminal.commKey = '4321';
    gateway = await startServer(config, outbox, (line) => logged.push(line));

    // No key, wrong key, right key: only the last is let in, and the two
    // refusals read identically.
    expect(await terminal().handshake()).toBe('403 DENIED');
    const wrongKey = fakeTerminal(`http://127.0.0.1:${gateway.port()}`, SERIAL, '9999');
    expect(await wrongKey.handshake()).toBe('403 DENIED');
    const rightKey = fakeTerminal(`http://127.0.0.1:${gateway.port()}`, SERIAL, '4321');
    expect(await rightKey.handshake()).toContain('Realtime=1');
    delete theTerminal.commKey;
  });

  it('tells the site nothing through the health line', async () => {
    await terminal().uploadPunchBurst(5);
    const response = await fetch(`http://127.0.0.1:${gateway.port()}/health`);
    const health = (await response.json()) as Record<string, unknown>;
    // No waiting counts, no serials: an unlisted caller learns only that
    // something answers here.
    expect(health).toEqual({ status: 'ok', alarmedTerminals: 0 });
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

  it('a broken line is quarantined — kept, counted, never sent, never lost', async () => {
    await terminal().upload('ATTLOG', ['1042\t2026-09-29 06:00:00\t0\t1', 'garbage']);
    expect(outbox.unsentCount()).toBe(1);
    expect(outbox.troubleCounts().quarantined).toBe(1);
    expect(logged.some((line) => line.includes('kept in the quarantine'))).toBe(true);
  });

  it('a photo upload is dropped whole, without a word about its contents', async () => {
    const answer = await terminal().upload('ATTPHOTO', ['jpeg-bytes-pretend']);
    expect(answer).toBe('200 OK: 0');
    expect(outbox.unsentCount()).toBe(0);
    expect(outbox.troubleCounts().quarantined).toBe(0);
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

    apiAnswer = honestAnswer;
    await delivery.pump(theTerminal);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('a 200 that fails to name a row never counts as its delivery', async () => {
    await terminal().uploadPunchBurst(3);
    // A captive portal's cheerful 200, naming nothing.
    apiAnswer = () => ({ status: 200, body: { results: [] } });
    await delivery.pump(theTerminal);
    expect(outbox.unsentCount()).toBe(3);
    expect(logged.some((line) => line.includes('answered for only 0 of 3'))).toBe(true);

    apiAnswer = honestAnswer;
    await delivery.pump(theTerminal);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('one poisoned row is isolated and rejected; the rows behind it still go', async () => {
    await terminal().uploadPunchBurst(10);
    const fourth = outbox.nextBatch(SERIAL, 'PUNCH')[3];
    const poisonId = (JSON.parse(fourth?.payload ?? '{}') as { deviceEventId: string })
      .deviceEventId;
    // The API refuses any batch containing the fourth punch, as a real 400 would.
    apiAnswer = (route, body) => {
      if (
        route === 'ingest/punches' &&
        (body as { punches: { deviceEventId: string }[] }).punches.some(
          (punch) => punch.deviceEventId === poisonId,
        )
      ) {
        return { status: 400, body: { title: 'Bad Request', status: 400 } };
      }
      return honestAnswer(route, body);
    };
    await delivery.pump(theTerminal);

    expect(outbox.unsentCount()).toBe(0);
    expect(outbox.troubleCounts().rejected).toBe(1);
    expect(logged.some((line) => line.startsWith('ALARM') && line.includes('malformed'))).toBe(
      true,
    );
    // And the poisoned row is never offered again.
    await delivery.pump(theTerminal);
    expect(outbox.troubleCounts().rejected).toBe(1);
  });

  it('raises one loud alarm on a 401, keeps the rows, and rests before retrying', async () => {
    await terminal().uploadPunchBurst(10);
    apiAnswer = () => ({ status: 401, body: { title: 'unauthorized', status: 401 } });
    await delivery.pump(theTerminal);
    await delivery.pump(theTerminal);

    const alarms = logged.filter((line) => line.startsWith('ALARM'));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain('switched');
    expect(outbox.unsentCount()).toBe(10);
    expect(delivery.alarmedSerials()).toEqual([SERIAL]);
    // The second pump rested: only one request reached the API.
    expect(apiCalls.filter((call) => call.route === 'ingest/punches')).toHaveLength(1);
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
    expect(outbox.unsentCount()).toBe(0);
  });
});

describe('the roster and the command queue', () => {
  const rosterWith =
    (users: { deviceUserRef: string; staffNumber: string; displayName: string }[]) =>
    (route: string, body: unknown) =>
      route === 'ingest/roster'
        ? { status: 200, body: { users, serverTime: '2026-09-29T10:00:00.000Z' } }
        : honestAnswer(route, body);

  it('adds who the roster names, and only an acknowledged add counts as done', async () => {
    apiAnswer = rosterWith([
      { deviceUserRef: '1042', staffNumber: 'SMT-01042', displayName: 'Kwame A.' },
    ]);
    await delivery.syncRoster(theTerminal);

    // The terminal polls and is told about Kwame; the id in the line is the
    // queue's own row id, so the acknowledgement below can actually land.
    const served = await terminal().pollCommand();
    expect(served).toContain('DATA USER PIN=1042');
    expect(served).toContain('Name=Kwame A.');
    const commandId = servedId(served);
    expect(Number.isInteger(commandId)).toBe(true);

    // Until the terminal acknowledges, it is not assumed to hold Kwame — and
    // a repeated roster queues nothing new meanwhile.
    expect(outbox.knownUsers(SERIAL)).toHaveLength(0);
    await delivery.syncRoster(theTerminal);
    expect(await terminal().pollCommand()).toBe('200 OK');

    await terminal().acknowledge(commandId);
    expect(outbox.knownUsers(SERIAL)).toEqual([{ deviceUserRef: '1042', displayName: 'Kwame A.' }]);
    expect(await terminal().pollCommand()).toBe('200 OK');
  });

  it('a failed acknowledgement reopens the command instead of assuming it done', async () => {
    apiAnswer = rosterWith([
      { deviceUserRef: '1042', staffNumber: 'SMT-01042', displayName: 'Kwame A.' },
    ]);
    await delivery.syncRoster(theTerminal);
    const commandId = servedId(await terminal().pollCommand());

    await terminal().acknowledge(commandId, 1);
    expect(outbox.knownUsers(SERIAL)).toHaveLength(0);
    // Served again straight away: the failure cleared the served mark.
    expect(await terminal().pollCommand()).toContain('DATA USER PIN=1042');
  });

  it("one terminal cannot acknowledge another terminal's command", async () => {
    apiAnswer = rosterWith([
      { deviceUserRef: '1042', staffNumber: 'SMT-01042', displayName: 'Kwame A.' },
    ]);
    await delivery.syncRoster(theTerminal);
    const commandId = servedId(await terminal().pollCommand());

    // A second terminal tries to close the first one's job: nothing happens.
    outbox.finishCommand('ZKOTHER', commandId, true);
    expect(outbox.knownUsers(SERIAL)).toHaveLength(0);

    await terminal().acknowledge(commandId);
    expect(outbox.knownUsers(SERIAL)).toHaveLength(1);
  });

  it('removes who the roster no longer names — a blocked duplicate leaves the terminal', async () => {
    apiAnswer = rosterWith([
      { deviceUserRef: '1042', staffNumber: 'SMT-01042', displayName: 'Kwame A.' },
    ]);
    await delivery.syncRoster(theTerminal);
    await terminal().acknowledge(servedId(await terminal().pollCommand()));

    apiAnswer = rosterWith([]);
    await delivery.syncRoster(theTerminal);
    const served = await terminal().pollCommand();
    expect(served).toContain('DELETE USERINFO PIN=1042');
    await terminal().acknowledge(servedId(served));
    expect(outbox.knownUsers(SERIAL)).toHaveLength(0);
  });

  it('a malformed roster answer is a log line, never a crash', async () => {
    apiAnswer = (route) =>
      route === 'ingest/roster' ? { status: 200, body: {} } : honestAnswer(route, {});
    await expect(delivery.syncRoster(theTerminal)).resolves.toBeUndefined();
  });
});
