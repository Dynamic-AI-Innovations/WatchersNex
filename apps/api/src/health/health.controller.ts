import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../db/database.module.js';
import type { Db } from '../db/database.js';

/**
 * Liveness and readiness for the platform and the external monitor.
 * Neither endpoint returns tenant data or configuration details.
 */
@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(): Promise<{ status: 'ok'; checks: { database: 'ok' } }> {
    try {
      await sql`SELECT 1`.execute(this.db);
    } catch {
      throw new ServiceUnavailableException('Database is not reachable');
    }
    return { status: 'ok', checks: { database: 'ok' } };
  }
}
