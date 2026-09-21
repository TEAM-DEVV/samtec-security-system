import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Post as ApiPost,
  ShiftPattern as ApiShiftPattern,
  PostList,
  ShiftPatternList,
} from '@samtec/contracts';
import type { SignedInUser } from '../../common/auth.decorators.js';
import { decodeCursor, toPage } from '../../common/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Post, ShiftPattern } from '../../generated/prisma/client.js';
import { AuditService } from '../identity/audit.service.js';
import { SitesService } from './sites.service.js';
import {
  type CreatePostBody,
  type CreateShiftPatternBody,
  type ListRosterQuery,
  toMinutes,
  toShiftTime,
  type UpdatePostBody,
  type UpdateShiftPatternBody,
} from './workforce.schemas.js';

/**
 * Posts (named guard positions at a site) and shift patterns (company-wide
 * working hours). Reads follow the same visibility rules as sites: a
 * SUPERVISOR only sees posts of their own sites; shift patterns belong to
 * the whole company, so every non-guard role may list them.
 */
@Injectable()
export class RostersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly audit: AuditService,
  ) {}

  // --- Posts -----------------------------------------------------------------

  async listPosts(viewer: SignedInUser, siteId: string, query: ListRosterQuery): Promise<PostList> {
    // Reuses the sites service's rules: a site the viewer may not see is a 404.
    await this.sites.get(viewer, siteId);

    const afterName = readCursor(query);
    const rows = await this.prisma.post.findMany({
      where: {
        companyId: viewer.companyId,
        siteId,
        ...(afterName ? { name: { gt: afterName } } : {}),
      },
      orderBy: { name: 'asc' },
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.name);
    return { items: pageRows.map(toApiPost), nextCursor };
  }

  async createPost(viewer: SignedInUser, siteId: string, body: CreatePostBody): Promise<ApiPost> {
    await this.sites.get(viewer, siteId); // 404 for a site outside the company.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const post = await tx.post.create({
          data: {
            companyId: viewer.companyId,
            siteId,
            name: body.name,
            requiredGuards: body.requiredGuards,
          },
        });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'post.created',
            entityType: 'post',
            entityId: post.id,
            detail: { siteId, name: post.name },
          },
          tx,
        );
        return toApiPost(post);
      });
    } catch (error) {
      throw duplicateNameToConflict(error, 'A post with this name already exists at this site.');
    }
  }

  async updatePost(viewer: SignedInUser, postId: string, body: UpdatePostBody): Promise<ApiPost> {
    const existing = await this.prisma.post.findFirst({
      where: { id: postId, companyId: viewer.companyId },
    });
    if (!existing) {
      throw new NotFoundException('No post exists with this ID.');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const post = await tx.post.update({ where: { id: postId }, data: body });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'post.updated',
            entityType: 'post',
            entityId: postId,
            detail: { changedFields: Object.keys(body).join(',') },
          },
          tx,
        );
        return toApiPost(post);
      });
    } catch (error) {
      throw duplicateNameToConflict(error, 'A post with this name already exists at this site.');
    }
  }

  // --- Shift patterns --------------------------------------------------------

  async listShiftPatterns(viewer: SignedInUser, query: ListRosterQuery): Promise<ShiftPatternList> {
    const afterName = readCursor(query);
    const rows = await this.prisma.shiftPattern.findMany({
      where: {
        companyId: viewer.companyId,
        ...(afterName ? { name: { gt: afterName } } : {}),
      },
      orderBy: { name: 'asc' },
      take: query.limit + 1,
    });
    const { pageRows, nextCursor } = toPage(rows, query.limit, (row) => row.name);
    return { items: pageRows.map(toApiShiftPattern), nextCursor };
  }

  async createShiftPattern(
    viewer: SignedInUser,
    body: CreateShiftPatternBody,
  ): Promise<ApiShiftPattern> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const pattern = await tx.shiftPattern.create({
          data: {
            companyId: viewer.companyId,
            name: body.name,
            startMinutes: toMinutes(body.startTime),
            endMinutes: toMinutes(body.endTime),
          },
        });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'shift_pattern.created',
            entityType: 'shift_pattern',
            entityId: pattern.id,
            detail: { name: pattern.name },
          },
          tx,
        );
        return toApiShiftPattern(pattern);
      });
    } catch (error) {
      throw duplicateNameToConflict(error, 'A shift pattern with this name already exists.');
    }
  }

  async updateShiftPattern(
    viewer: SignedInUser,
    shiftPatternId: string,
    body: UpdateShiftPatternBody,
  ): Promise<ApiShiftPattern> {
    const existing = await this.prisma.shiftPattern.findFirst({
      where: { id: shiftPatternId, companyId: viewer.companyId },
    });
    if (!existing) {
      throw new NotFoundException('No shift pattern exists with this ID.');
    }
    const { startTime, endTime, ...rest } = body;
    // The final times must still make sense together, even when only one changes.
    const finalStart = startTime !== undefined ? toMinutes(startTime) : existing.startMinutes;
    const finalEnd = endTime !== undefined ? toMinutes(endTime) : existing.endMinutes;
    if (finalStart === finalEnd) {
      throw new BadRequestException({
        message: [{ path: ['endTime'], message: 'The end time cannot equal the start time.' }],
      });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const pattern = await tx.shiftPattern.update({
          where: { id: shiftPatternId },
          data: {
            ...rest,
            ...(startTime !== undefined ? { startMinutes: toMinutes(startTime) } : {}),
            ...(endTime !== undefined ? { endMinutes: toMinutes(endTime) } : {}),
          },
        });
        await this.audit.record(
          {
            companyId: viewer.companyId,
            actorUserId: viewer.userId,
            action: 'shift_pattern.updated',
            entityType: 'shift_pattern',
            entityId: shiftPatternId,
            detail: { changedFields: Object.keys(body).join(',') },
          },
          tx,
        );
        return toApiShiftPattern(pattern);
      });
    } catch (error) {
      throw duplicateNameToConflict(error, 'A shift pattern with this name already exists.');
    }
  }
}

/** Both roster lists page by name; a bad cursor is a clear 400. */
function readCursor(query: ListRosterQuery): string | undefined {
  const afterName = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && afterName === undefined) {
    throw new BadRequestException({
      message: [
        { path: ['cursor'], message: 'The cursor is not valid. Start again from the first page.' },
      ],
    });
  }
  return afterName;
}

/** A broken unique-name rule (Prisma P2002) becomes a clear 409; anything else rethrows. */
function duplicateNameToConflict(error: unknown, message: string): unknown {
  const candidate = error as { code?: unknown };
  if (typeof error === 'object' && error !== null && candidate.code === 'P2002') {
    return new ConflictException(message);
  }
  return error;
}

function toApiPost(post: Post): ApiPost {
  return {
    id: post.id,
    siteId: post.siteId,
    name: post.name,
    requiredGuards: post.requiredGuards,
    status: post.status,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

function toApiShiftPattern(pattern: ShiftPattern): ApiShiftPattern {
  return {
    id: pattern.id,
    name: pattern.name,
    startTime: toShiftTime(pattern.startMinutes),
    endTime: toShiftTime(pattern.endMinutes),
    // Ending at or before the start means the shift runs into the next day.
    crossesMidnight: pattern.endMinutes <= pattern.startMinutes,
    createdAt: pattern.createdAt.toISOString(),
    updatedAt: pattern.updatedAt.toISOString(),
  };
}
