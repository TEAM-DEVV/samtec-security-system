import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@samtec/contracts';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Reuse a database check for this long. The endpoint is public, so this stops
 * frequent calls from making the database do extra work.
 */
const CHECK_CACHE_MILLISECONDS = 5_000;

@Injectable()
export class HealthService {
  private lastCheck: { databaseUp: boolean; checkedAt: number } | undefined;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks the API's dependencies. The return type comes from the API contract,
   * so TypeScript fails the build if this ever drifts from `openapi.yaml`.
   *
   * The endpoint is public, so it deliberately reveals no version, environment
   * or uptime: details like those help attackers plan.
   */
  async check(): Promise<HealthResponse> {
    const databaseUp = await this.isDatabaseUp();
    return {
      status: databaseUp ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      checks: { database: databaseUp ? 'up' : 'down' },
    };
  }

  private async isDatabaseUp(): Promise<boolean> {
    const now = Date.now();
    if (this.lastCheck !== undefined && now - this.lastCheck.checkedAt < CHECK_CACHE_MILLISECONDS) {
      return this.lastCheck.databaseUp;
    }
    const databaseUp = await this.prisma.isReachable();
    this.lastCheck = { databaseUp, checkedAt: now };
    return databaseUp;
  }
}
