import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { SitesController } from './sites.controller.js';
import { SitesService } from './sites.service.js';

/**
 * The workforce module: employees, sites and (later in Phase 1) posts, shift
 * patterns and assignments. It owns those tables; other modules ask its
 * services instead of reading them (docs/plan/03-system-architecture.md).
 */
@Module({
  imports: [IdentityModule],
  controllers: [EmployeesController, SitesController],
  providers: [EmployeesService, SitesService],
  exports: [EmployeesService, SitesService],
})
export class WorkforceModule {}
