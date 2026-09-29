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
  /** The firmware's comm key, checked when the terminal sends one. */
  commKey?: string;
}

export interface GatewayConfig {
  apiUrl: string;
  port: number;
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
  const parsed: unknown = JSON.parse(text);
  return checkedConfig(parsed, path);
}

/** The same checks for a config a test builds in memory. */
export function checkedConfig(parsed: unknown, source = 'the configuration'): GatewayConfig {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${source} is not a JSON object.`);
  }
  const config = parsed as Partial<GatewayConfig>;
  if (typeof config.apiUrl !== 'string' || !config.apiUrl.startsWith('http')) {
    throw new Error(`${source}: "apiUrl" must be the API's address, ending /api/v1.`);
  }
  if (typeof config.port !== 'number' || !Number.isInteger(config.port)) {
    throw new Error(`${source}: "port" must be a whole number (the design says 8081).`);
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
    if (!Array.isArray(terminal.allowedIps)) {
      throw new Error(`${source}: terminal ${terminal.serial} needs "allowedIps" (a list).`);
    }
  }
  return config as GatewayConfig;
}
