import { type Env, parseEnv } from './env.js';

/**
 * The API's validated configuration. Nest injects it wherever it is needed:
 *
 *   constructor(private readonly config: AppConfig) {}
 *
 * Tests create their own instance instead of reading real environment variables.
 */
export class AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly databaseUrl: string;
  readonly corsOrigins: readonly string[];
  /** The master secret behind sign-in. Never log it. */
  readonly authSecret: string;
  /** Which biometric provider attendance uses; only the mock exists until Phase 3. */
  readonly biometricProvider: 'mock';
  /** Whether simulator (MOCK) devices may send punches. Refused in production unless ALLOW_SIMULATOR_DEVICES=yes. */
  readonly allowSimulatorDevices: boolean;
  /** The version from package.json. pnpm sets `npm_package_version` when it runs a script. */
  readonly version: string;

  constructor(env: Env, version = 'dev') {
    this.nodeEnv = env.NODE_ENV;
    this.port = env.PORT;
    this.databaseUrl = env.DATABASE_URL;
    this.corsOrigins = env.CORS_ORIGINS;
    this.authSecret = env.AUTH_SECRET;
    this.biometricProvider = env.BIOMETRIC_PROVIDER ?? 'mock';
    this.allowSimulatorDevices =
      env.ALLOW_SIMULATOR_DEVICES === undefined
        ? env.NODE_ENV !== 'production'
        : env.ALLOW_SIMULATOR_DEVICES === 'yes';
    this.version = version;
  }

  /** Reads and checks `process.env`. Throws a readable error when something is wrong. */
  static fromProcessEnv(): AppConfig {
    return new AppConfig(parseEnv(process.env), process.env.npm_package_version);
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
