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

  constructor(env: Env) {
    this.nodeEnv = env.NODE_ENV;
    this.port = env.PORT;
    this.databaseUrl = env.DATABASE_URL;
    this.corsOrigins = env.CORS_ORIGINS;
  }

  /** Reads and checks `process.env`. Throws a readable error when something is wrong. */
  static fromProcessEnv(): AppConfig {
    return new AppConfig(parseEnv(process.env));
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
