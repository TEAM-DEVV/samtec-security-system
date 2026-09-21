import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { UserAccount, UserAccountList, UserAccountWithPasswordSetup } from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import {
  type CreateUserBody,
  createUserSchema,
  type ListUsersQuery,
  listUsersQuerySchema,
  type UpdateUserBody,
  updateUserSchema,
  userIdSchema,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

/**
 * `/api/v1/users`. Contract: the `Users` operations. The whole controller is
 * ADMIN only; the service adds the never-on-yourself rule.
 */
@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listUsersQuerySchema }) query: ListUsersQuery,
  ): Promise<UserAccountList> {
    return this.users.list(caller, query);
  }

  @Post()
  async create(
    @Caller() caller: SignedInUser,
    @Body({ schema: createUserSchema }) body: CreateUserBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserAccountWithPasswordSetup> {
    const created = await this.users.create(caller, body);
    response
      .status(201)
      .setHeader('Location', `/api/v1/users/${created.user.id}`)
      // The body holds a one-time link token: no browser or proxy may keep it.
      .setHeader('Cache-Control', 'no-store');
    return created;
  }

  @Get(':userId')
  get(
    @Caller() caller: SignedInUser,
    @Param('userId', { schema: userIdSchema }) userId: string,
  ): Promise<UserAccount> {
    return this.users.get(caller, userId);
  }

  @Patch(':userId')
  update(
    @Caller() caller: SignedInUser,
    @Param('userId', { schema: userIdSchema }) userId: string,
    @Body({ schema: updateUserSchema }) body: UpdateUserBody,
  ): Promise<UserAccount> {
    return this.users.update(caller, userId, body);
  }

  @Post(':userId/deactivate')
  @HttpCode(200)
  deactivate(
    @Caller() caller: SignedInUser,
    @Param('userId', { schema: userIdSchema }) userId: string,
  ): Promise<UserAccount> {
    return this.users.deactivate(caller, userId);
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  reactivate(
    @Caller() caller: SignedInUser,
    @Param('userId', { schema: userIdSchema }) userId: string,
  ): Promise<UserAccount> {
    return this.users.reactivate(caller, userId);
  }

  @Post(':userId/reset-sign-in')
  @HttpCode(200)
  async resetSignIn(
    @Caller() caller: SignedInUser,
    @Param('userId', { schema: userIdSchema }) userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserAccountWithPasswordSetup> {
    const reset = await this.users.resetSignIn(caller, userId);
    response.setHeader('Cache-Control', 'no-store');
    return reset;
  }
}
