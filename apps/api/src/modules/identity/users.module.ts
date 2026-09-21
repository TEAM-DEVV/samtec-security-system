import { Module } from '@nestjs/common';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { IdentityModule } from './identity.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/**
 * User management, part of the identity module's job (it owns the account
 * tables). It is a separate Nest module only because it also needs the
 * workforce module, to check employee links — and the workforce module
 * already uses identity (for the audit log). Keeping this piece apart means
 * no module imports one that imports it back:
 *
 *   IdentityModule  <-  WorkforceModule  <-  UsersModule  ->  IdentityModule
 */
@Module({
  imports: [IdentityModule, WorkforceModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
