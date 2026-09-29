/**
 * The door the terminals knock on: plain HTTP on the site's own network,
 * never the internet (docs/plan/13 section 5). A terminal is the client —
 * it uploads its logs and polls for commands; the gateway only ever answers.
 *
 * Two checks stand in front of everything: the serial number must be listed,
 * and the caller's address must be listed for that serial. Where a comm key
 * is configured it is **required**, not merely checked when offered — a key
 * that can be skipped is a decoration. Every refusal is the same one word,
 * so a stray phone on the site's Wi-Fi can map nothing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { GatewayConfig, TerminalConfig } from './config.ts';
import { handshakeReply, parseUpload } from './iclock.ts';
import type { Outbox } from './outbox.ts';

/** Uploads above this are refused unread: a batch of 500 lines is ~25 kB. */
const MAX_BODY_BYTES = 1_000_000;

export interface GatewayServer {
  server: Server;
  /** Where it is listening, for the fake terminal and the tests. */
  port: () => number;
  close: () => Promise<void>;
}

export function startServer(
  config: GatewayConfig,
  outbox: Outbox,
  log: (line: string) => void = console.log,
  /** What the health line may add — the alarmed serials, from delivery. */
  alarms: () => string[] = () => [],
): Promise<GatewayServer> {
  const server = createServer((request, response) => {
    void handle(config, outbox, log, alarms, request, response).catch((error: unknown) => {
      // A store failure here is the one failure that threatens "never lose a
      // punch", so it is the one 500 that must reach the log — the message
      // only, never the body.
      log(
        `ERROR answering ${request.url ?? '?'}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      respond(response, 500, 'ERROR');
    });
  });
  return new Promise((resolve) => {
    // Bound to the configured address; the README says never the internet,
    // and a config can now say which network card the site's terminals reach.
    server.listen(config.port, config.host, () => {
      resolve({
        server,
        port: () => {
          const address = server.address();
          return typeof address === 'object' && address !== null ? address.port : config.port;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function handle(
  config: GatewayConfig,
  outbox: Outbox,
  log: (line: string) => void,
  alarms: () => string[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://gateway.invalid');

  // The one unauthenticated line: is this gateway alive. Counts and serials
  // stay out of it — an unlisted caller on the site network learns nothing
  // beyond "something answers here".
  if (url.pathname === '/health') {
    const alarmed = alarms().length;
    respond(
      response,
      200,
      JSON.stringify({ status: alarmed === 0 ? 'ok' : 'alarm', alarmedTerminals: alarmed }),
    );
    return;
  }

  const terminal = trustedTerminal(config, url, request);
  if (terminal === null) {
    // One refusal for every reason — an unknown serial, a wrong address, a
    // missing or wrong key — so nothing can map what is listed.
    respond(response, 403, 'DENIED');
    return;
  }

  if (url.pathname === '/iclock/cdata' && request.method === 'GET') {
    respond(response, 200, handshakeReply(terminal.serial));
    return;
  }

  if (url.pathname === '/iclock/cdata' && request.method === 'POST') {
    const body = await readBody(request);
    if (body === null) {
      respond(response, 413, 'ERROR');
      return;
    }
    const table = url.searchParams.get('table') ?? '';
    const parsed = parseUpload(terminal.serial, table, body);
    if (
      parsed.punches.length === 0 &&
      parsed.enrollments.length === 0 &&
      parsed.broken.length === 0 &&
      !['ATTLOG', 'OPERLOG', 'ATTPHOTO', 'BIOPHOTO', 'BIODATA'].includes(table)
    ) {
      // A table this gateway does not speak. The name is worth a log line —
      // it is how a firmware quirk is discovered — but never the body.
      log(`${terminal.serial}: upload for unknown table "${table.slice(0, 32)}" ignored.`);
    }
    // On disk first — the readable and the broken alike — then OK. The
    // ordering is the gateway's whole promise, and a broken line is kept in
    // the quarantine because a terminal that hears OK never resends it.
    outbox.store(terminal.serial, parsed.punches, parsed.enrollments, parsed.broken, table);
    if (parsed.broken.length > 0) {
      log(
        `${terminal.serial}: ${parsed.broken.length} line(s) could not be read; ` +
          'kept in the quarantine.',
      );
    }
    respond(response, 200, `OK: ${parsed.punches.length + parsed.enrollments.length}`);
    return;
  }

  if (url.pathname === '/iclock/getrequest' && request.method === 'GET') {
    const command = outbox.nextCommand(terminal.serial);
    respond(response, 200, command === null ? 'OK' : command.line);
    return;
  }

  if (url.pathname === '/iclock/devicecmd' && request.method === 'POST') {
    // The terminal acknowledges `C:<id>:…` with `ID=<id>&Return=<code>&…`,
    // and real firmware batches several acknowledgements, one per line.
    // `Return=0` is success; anything else reopens the command, so a failed
    // add is served again rather than assumed done.
    const body = (await readBody(request)) ?? '';
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (line === '') {
        continue;
      }
      const fields = new URLSearchParams(line);
      const id = Number(fields.get('ID'));
      if (Number.isInteger(id)) {
        outbox.finishCommand(terminal.serial, id, (fields.get('Return') ?? '0') === '0');
      }
    }
    respond(response, 200, 'OK');
    return;
  }

  respond(response, 404, 'ERROR');
}

/** The listed terminal this request may speak for, or null. */
function trustedTerminal(
  config: GatewayConfig,
  url: URL,
  request: IncomingMessage,
): TerminalConfig | null {
  const serial = url.searchParams.get('SN') ?? '';
  const terminal = config.terminals.find((listed) => listed.serial === serial);
  if (terminal === undefined) {
    return null;
  }
  const caller = request.socket.remoteAddress ?? '';
  // `::ffff:192.168.1.50` and `192.168.1.50` are the same caller.
  const address = caller.replace(/^::ffff:/, '');
  if (!terminal.allowedIps.includes(address)) {
    return null;
  }
  if (terminal.commKey !== undefined) {
    const sentKey = url.searchParams.get('pushcommkey') ?? url.searchParams.get('key');
    if (sentKey !== terminal.commKey) {
      return null;
    }
  }
  return terminal;
}

/** The whole body as text, or null when it is too large to trust. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const pieces: Buffer[] = [];
    let size = 0;
    request.on('data', (piece: Buffer) => {
      size += piece.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      pieces.push(piece);
    });
    request.on('end', () => resolve(Buffer.concat(pieces).toString('utf8')));
    request.on('error', reject);
  });
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain' });
  response.end(body);
}
