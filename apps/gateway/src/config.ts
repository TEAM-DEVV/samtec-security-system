/**
 * What a gateway needs to know, read once at start.
 *
 * The file lives **outside the repository** (like the backup's database file,
 * `docs/guides/11-backup-and-restore.md`), because it holds each terminal's
 * device secret and `git add` must never be able to reach it. The path comes
 * from `SAMTEC_GATEWAY_CONFIG`, or defaults to `.samtec/gateway.json` in the
 * user's home folder.
 *
 * ```json
 * {
 *   "apiUrl": "https://samtec-test-api.vercel.app/api/v1",
 *   "port": 8081,
 *   "outboxFile": "C:/Users/you/.samtec/gateway-outbox.db",
 *   "terminals": [
 *     {
 *       "serial": "ZK1234567890",
 *       "allowedIps": ["192.168.1.50"],
 *       "deviceId": "<the dashboard's device ID>",
 *       "secret": "<the device secret, shown once at registration>",
 *       "commKey": "0"
 *     }
 *   ]
 * }
 * ```
 *
 * Each terminal is a `ZKTECO` device registered on the dashboard's Devices
 * page — born switched off, switched on by a second administrator, like every
 * device key (docs/plan/06, "Two administrators").
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TerminalConfig {
  serial: string;
  /** Only these addresses may speak as this serial. Empty allows none. */
  allowedIps: string[];
  deviceId: string;
  secret: string;
  /** The firmware's comm key. When configured it is required on every request. */
  commKey?: string;
}

export interface GatewayConfig {
  apiUrl: string;
  port: number;
  /**
   * The address to listen on. Set it to the LAN address the terminals reach,
   * so the door never faces a network it was not meant for; left out, every
   * interface is bound, which is only right on a machine with one network.
   */
  host?: string;
  outboxFile: string;
  terminals: TerminalConfig[];
}

export function defaultConfigPath(): string {
  return process.env.SAMTEC_GATEWAY_CONFIG ?? join(homedir(), '.samtec', 'gateway.json');
}

/** Reads and checks the file. Refusing to start beats running half-configured. */
export function loadConfig(path = defaultConfigPath()): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No gateway configuration at ${path}. Create it (the shape is documented in ` +
        'apps/gateway/src/config.ts) or point SAMTEC_GATEWAY_CONFIG at it.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never rethrow the parser's own message: V8 quotes the source text
    // around the problem, and this file holds device secrets.
    throw new Error(`The gateway configuration at ${path} is not valid JSON.`);
  }
  return checkedConfig(parsed, path);
}

/** The same checks for a config a test builds in memory. */
export function checkedConfig(parsed: unknown, source = 'the configuration'): GatewayConfig {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${source} is not a JSON object.`);
  }
  const config = parsed as Partial<GatewayConfig>;
  if (
    typeof config.apiUrl !== 'string' ||
    !(config.apiUrl.startsWith('http://') || config.apiUrl.startsWith('https://'))
  ) {
    throw new Error(`${source}: "apiUrl" must be the API's address, ending /api/v1.`);
  }
  if (
    typeof config.port !== 'number' ||
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  ) {
    throw new Error(`${source}: "port" must be a port number (the design says 8081).`);
  }
  if (config.host !== undefined && (typeof config.host !== 'string' || config.host === '')) {
    throw new Error(`${source}: "host", when given, must be the address to listen on.`);
  }
  if (typeof config.outboxFile !== 'string' || config.outboxFile === '') {
    throw new Error(`${source}: "outboxFile" must be a file path for the outbox database.`);
  }
  if (!Array.isArray(config.terminals) || config.terminals.length === 0) {
    throw new Error(`${source}: "terminals" must list at least one terminal.`);
  }
  for (const terminal of config.terminals) {
    for (const field of ['serial', 'deviceId', 'secret'] as const) {
      if (typeof terminal[field] !== 'string' || terminal[field] === '') {
        throw new Error(`${source}: every terminal needs a "${field}".`);
      }
    }
    if (
      !Array.isArray(terminal.allowedIps) ||
      terminal.allowedIps.some((ip) => typeof ip !== 'string' || ip === '')
    ) {
      throw new Error(`${source}: terminal ${terminal.serial} needs "allowedIps" (addresses).`);
    }
  }
  const serials = config.terminals.map((terminal) => terminal.serial);
  if (new Set(serials).size !== serials.length) {
    throw new Error(`${source}: two terminals share a serial number.`);
  }
  return config as GatewayConfig;
}
