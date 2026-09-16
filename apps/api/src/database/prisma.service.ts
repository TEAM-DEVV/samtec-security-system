import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../config/app-config.js';
import { PrismaClient } from '../generated/prisma/client.js';

/** How long the health check waits for the database to answer a query. */
const HEALTH_QUERY_TIMEOUT_MS = 3_000;

/**
 * The one database client for the whole API.
 *
 * Inject it into a service and query with Prisma:
 *
 *   constructor(private readonly prisma: PrismaService) {}
 *   ...
 *   await this.prisma.employee.findMany({ where: { status: 'ACTIVE' } });
 *
 * Only the module that owns a table may write to it (docs/plan/03-system-architecture.md).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        // Give up quickly when the database cannot be reached at all.
        connectionTimeoutMillis: 5_000,
      }),
      // Short error messages. The detailed format can repeat the values being
      // saved, such as Ghana Card numbers, and those must never reach the logs.
      errorFormat: 'minimal',
    });
  }

  /**
   * Runs a trivial query to find out whether the database answers. A database
   * can accept connections and then stop answering, so give up after 3 seconds.
   */
  async isReachable(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeout = new Error('The database did not answer in time');
        timeout.name = 'DatabaseTimeout';
        reject(timeout);
      }, HEALTH_QUERY_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.$queryRaw`SELECT 1`, giveUp]);
      return true;
    } catch (error) {
      // Log only the kind of error. Its message can contain connection details.
      this.logger.warn(`Database is not reachable (${errorKind(error)})`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** For example "Error ECONNREFUSED" or "DatabaseTimeout", without the message. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code = 'code' in error && typeof error.code === 'string' ? ` ${error.code}` : '';
  return `${error.name}${code}`;
}
