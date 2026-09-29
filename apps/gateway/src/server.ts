/**
 * The door the terminals knock on: plain HTTP on the site's own network,
 * never the internet (docs/plan/13 section 5). A terminal is the client —
 * it uploads its logs and polls for commands; the gateway only ever answers.
 *
 * Two checks stand in front of everything: the serial number must be listed,
 * and the caller's address must be listed for that serial. A stray phone on
 * the site's Wi-Fi gets a refusal that names nothing. Where the firmware
 * sends its comm key, that is checked too.
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
): Promise<GatewayServer> {
  const server = createServer((request, response) => {
    void handle(config, outbox, log, request, response).catch(() => {
      respond(response, 500, 'ERROR');
    });
  });
  return new Promise((resolve) => {
    server.listen(config.port, () => {
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
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://gateway.invalid');

  // The one unauthenticated line: is this gateway alive, and how far behind.
  if (url.pathname === '/health') {
    respond(response, 200, JSON.stringify({ status: 'ok', waiting: outbox.unsentCount() }));
    return;
  }

  const terminal = trustedTerminal(config, url, request);
  if (terminal === null) {
    // One refusal for every reason — an unknown serial, a wrong address, a
    // wrong key — so nothing on the site's network can map what is listed.
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
    // On disk first, then OK — the ordering is the gateway's whole promise.
    outbox.store(terminal.serial, parsed.punches, parsed.enrollments);
    if (parsed.brokenLines > 0) {
      log(`${terminal.serial}: ${parsed.brokenLines} line(s) could not be read and were dropped.`);
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
    // The terminal acknowledges `C:<id>:…` with `ID=<id>&Return=0&…`.
    const body = (await readBody(request)) ?? '';
    const id = Number(new URLSearchParams(body.trim()).get('ID') ?? url.searchParams.get('ID'));
    if (Number.isInteger(id)) {
      outbox.finishCommand(id);
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
  const sentKey = url.searchParams.get('pushcommkey') ?? url.searchParams.get('key');
  if (terminal.commKey !== undefined && sentKey !== null && sentKey !== terminal.commKey) {
    return null;
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
