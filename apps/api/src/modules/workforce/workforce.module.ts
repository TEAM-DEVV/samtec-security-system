import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { PostsController, ShiftPatternsController } from './rosters.controller.js';
import { RostersService } from './rosters.service.js';
import { SiteDeactivationChecks } from './site-deactivation-checks.js';
import { SitesController } from './sites.controller.js';
import { SitesService } from './sites.service.js';

/**
 * The workforce module: employees, sites and (later in Phase 1) posts, shift
 * patterns and assignments. It owns those tables; other modules ask its
 * services instead of reading them (docs/plan/03-system-architecture.md), and
 * it reads none of theirs: where it needs their answer (may this site go
 * inactive?), they register a check in `SiteDeactivationChecks` instead.
 */
@Module({
  imports: [IdentityModule],
  controllers: [EmployeesController, SitesController, PostsController, ShiftPatternsController],
  providers: [EmployeesService, SitesService, RostersService, SiteDeactivationChecks],
  exports: [EmployeesService, SitesService, RostersService, SiteDeactivationChecks],
})
export class WorkforceModule {}
