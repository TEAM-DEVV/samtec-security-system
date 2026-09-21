import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type {
  Post as ApiPost,
  ShiftPattern as ApiShiftPattern,
  PostList,
  ShiftPatternList,
} from '@samtec/contracts';
import type { Response } from 'express';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { RostersService } from './rosters.service.js';
import {
  type CreatePostBody,
  type CreateShiftPatternBody,
  createPostSchema,
  createShiftPatternSchema,
  idSchema,
  type ListRosterQuery,
  listRosterQuerySchema,
  type UpdatePostBody,
  type UpdateShiftPatternBody,
  updatePostSchema,
  updateShiftPatternSchema,
} from './workforce.schemas.js';

/**
 * `/api/v1/sites/{siteId}/posts` and `/api/v1/posts/{postId}`. Contract:
 * operations `listPosts`, `createPost` and `updatePost`.
 */
@Controller()
export class PostsController {
  constructor(private readonly rosters: RostersService) {}

  @Get('sites/:siteId/posts')
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  list(
    @Caller() caller: SignedInUser,
    @Param('siteId', { schema: idSchema }) siteId: string,
    @Query({ schema: listRosterQuerySchema }) query: ListRosterQuery,
  ): Promise<PostList> {
    return this.rosters.listPosts(caller, siteId, query);
  }

  @Post('sites/:siteId/posts')
  @Roles('ADMIN', 'HR_PAYROLL')
  async create(
    @Caller() caller: SignedInUser,
    @Param('siteId', { schema: idSchema }) siteId: string,
    @Body({ schema: createPostSchema }) body: CreatePostBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiPost> {
    const post = await this.rosters.createPost(caller, siteId, body);
    response.status(201).setHeader('Location', `/api/v1/sites/${siteId}/posts`);
    return post;
  }

  @Patch('posts/:postId')
  @Roles('ADMIN', 'HR_PAYROLL')
  update(
    @Caller() caller: SignedInUser,
    @Param('postId', { schema: idSchema }) postId: string,
    @Body({ schema: updatePostSchema }) body: UpdatePostBody,
  ): Promise<ApiPost> {
    return this.rosters.updatePost(caller, postId, body);
  }
}

/**
 * `/api/v1/shift-patterns`. Contract: operations `listShiftPatterns`,
 * `createShiftPattern` and `updateShiftPattern`.
 */
@Controller('shift-patterns')
export class ShiftPatternsController {
  constructor(private readonly rosters: RostersService) {}

  @Get()
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listRosterQuerySchema }) query: ListRosterQuery,
  ): Promise<ShiftPatternList> {
    return this.rosters.listShiftPatterns(caller, query);
  }

  @Post()
  @Roles('ADMIN', 'HR_PAYROLL')
  async create(
    @Caller() caller: SignedInUser,
    @Body({ schema: createShiftPatternSchema }) body: CreateShiftPatternBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiShiftPattern> {
    const pattern = await this.rosters.createShiftPattern(caller, body);
    response.status(201).setHeader('Location', '/api/v1/shift-patterns');
    return pattern;
  }

  @Patch(':shiftPatternId')
  @Roles('ADMIN', 'HR_PAYROLL')
  update(
    @Caller() caller: SignedInUser,
    @Param('shiftPatternId', { schema: idSchema }) shiftPatternId: string,
    @Body({ schema: updateShiftPatternSchema }) body: UpdateShiftPatternBody,
  ): Promise<ApiShiftPattern> {
    return this.rosters.updateShiftPattern(caller, shiftPatternId, body);
  }
}
