import type {
  CreatePostRequest,
  CreateShiftPatternRequest,
  Post,
  PostList,
  ShiftPattern,
  ShiftPatternList,
  UpdatePostRequest,
  UpdateShiftPatternRequest,
} from '@samtec/contracts';
import { HttpResponse, http, type PathParams } from 'msw';
import { mockPosts, mockShiftPatterns } from '../data/rosters';
import { mockSites } from '../data/sites';
import {
  apiUrl,
  conflict,
  isUuid,
  notFound,
  type OrProblem,
  pageOf,
  readLimit,
  validationProblem,
} from '../helpers';

/**
 * The mock API keeps its own copies so the write handlers can change them.
 * Tests call `resetMockRosters()` to start fresh.
 */
let posts: Post[] = mockPosts.map((post) => ({ ...post }));
let shiftPatterns: ShiftPattern[] = mockShiftPatterns.map((pattern) => ({ ...pattern }));

export function resetMockRosters(): void {
  posts = mockPosts.map((post) => ({ ...post }));
  shiftPatterns = mockShiftPatterns.map((pattern) => ({ ...pattern }));
}

const SHIFT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkName(name: unknown): string | undefined {
  return typeof name === 'string' && name.length >= 2 && name.length <= 60 ? name : undefined;
}

export const rosterHandlers = [
  http.get<{ siteId: string }, never, OrProblem<PostList>>(
    apiUrl('/sites/:siteId/posts'),
    ({ params, request }) => {
      if (!isUuid(params.siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      if (!mockSites.some((site) => site.id === params.siteId)) {
        return notFound('No site exists with this ID.');
      }
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const matches = posts
        .filter((post) => post.siteId === params.siteId)
        .sort((a, b) => a.name.localeCompare(b.name));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<PostList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.post<{ siteId: string }, CreatePostRequest, OrProblem<Post>>(
    apiUrl('/sites/:siteId/posts'),
    async ({ params, request }) => {
      if (!isUuid(params.siteId)) {
        return validationProblem('siteId', 'Must be a valid ID.');
      }
      if (!mockSites.some((site) => site.id === params.siteId)) {
        return notFound('No site exists with this ID.');
      }
      const body = await request.json();
      const name = checkName(body.name);
      if (name === undefined) {
        return validationProblem('name', 'Must be 2 to 60 characters long.');
      }
      const requiredGuards = body.requiredGuards ?? 1;
      if (!Number.isInteger(requiredGuards) || requiredGuards < 1 || requiredGuards > 50) {
        return validationProblem('requiredGuards', 'Must be a whole number from 1 to 50.');
      }
      if (posts.some((post) => post.siteId === params.siteId && post.name === name)) {
        return conflict('A post with this name already exists at this site.');
      }
      const now = new Date().toISOString();
      const post: Post = {
        id: crypto.randomUUID(),
        siteId: params.siteId,
        name,
        requiredGuards,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      posts.push(post);
      return HttpResponse.json<Post>(post, {
        status: 201,
        headers: { Location: `/api/v1/sites/${params.siteId}/posts` },
      });
    },
  ),

  http.patch<{ postId: string }, UpdatePostRequest, OrProblem<Post>>(
    apiUrl('/posts/:postId'),
    async ({ params, request }) => {
      if (!isUuid(params.postId)) {
        return validationProblem('postId', 'Must be a valid ID.');
      }
      const post = posts.find((candidate) => candidate.id === params.postId);
      if (!post) {
        return notFound('No post exists with this ID.');
      }
      const body = await request.json();
      if (Object.keys(body).length === 0) {
        return validationProblem('body', 'Send at least one field to change.');
      }
      if (body.name !== undefined) {
        const name = checkName(body.name);
        if (name === undefined) {
          return validationProblem('name', 'Must be 2 to 60 characters long.');
        }
        if (posts.some((p) => p.siteId === post.siteId && p.name === name && p.id !== post.id)) {
          return conflict('A post with this name already exists at this site.');
        }
        post.name = name;
      }
      if (body.requiredGuards !== undefined) post.requiredGuards = body.requiredGuards;
      if (body.status !== undefined) post.status = body.status;
      post.updatedAt = new Date().toISOString();
      return HttpResponse.json<Post>(post);
    },
  ),

  http.get<PathParams, never, OrProblem<ShiftPatternList>>(
    apiUrl('/shift-patterns'),
    ({ request }) => {
      const query = new URL(request.url).searchParams;
      const limit = readLimit(query);
      if (limit === undefined) {
        return validationProblem('limit', 'Must be a whole number from 1 to 100.');
      }
      const matches = [...shiftPatterns].sort((a, b) => a.name.localeCompare(b.name));
      const page = pageOf(matches, limit, query.get('cursor'));
      return page
        ? HttpResponse.json<ShiftPatternList>(page)
        : validationProblem('cursor', 'The cursor is not valid. Start again from the first page.');
    },
  ),

  http.post<PathParams, CreateShiftPatternRequest, OrProblem<ShiftPattern>>(
    apiUrl('/shift-patterns'),
    async ({ request }) => {
      const body = await request.json();
      const name = checkName(body.name);
      if (name === undefined) {
        return validationProblem('name', 'Must be 2 to 60 characters long.');
      }
      if (!SHIFT_TIME.test(body.startTime ?? '')) {
        return validationProblem('startTime', 'Must be a time like 06:00 or 18:30.');
      }
      if (!SHIFT_TIME.test(body.endTime ?? '')) {
        return validationProblem('endTime', 'Must be a time like 06:00 or 18:30.');
      }
      if (body.startTime === body.endTime) {
        return validationProblem('endTime', 'The end time cannot equal the start time.');
      }
      if (shiftPatterns.some((pattern) => pattern.name === name)) {
        return conflict('A shift pattern with this name already exists.');
      }
      const now = new Date().toISOString();
      const pattern: ShiftPattern = {
        id: crypto.randomUUID(),
        name,
        startTime: body.startTime,
        endTime: body.endTime,
        crossesMidnight: body.endTime <= body.startTime,
        createdAt: now,
        updatedAt: now,
      };
      shiftPatterns.push(pattern);
      return HttpResponse.json<ShiftPattern>(pattern, {
        status: 201,
        headers: { Location: '/api/v1/shift-patterns' },
      });
    },
  ),

  http.patch<{ shiftPatternId: string }, UpdateShiftPatternRequest, OrProblem<ShiftPattern>>(
    apiUrl('/shift-patterns/:shiftPatternId'),
    async ({ params, request }) => {
      if (!isUuid(params.shiftPatternId)) {
        return validationProblem('shiftPatternId', 'Must be a valid ID.');
      }
      const pattern = shiftPatterns.find((candidate) => candidate.id === params.shiftPatternId);
      if (!pattern) {
        return notFound('No shift pattern exists with this ID.');
      }
      const body = await request.json();
      if (Object.keys(body).length === 0) {
        return validationProblem('body', 'Send at least one field to change.');
      }
      if (body.name !== undefined) {
        const name = checkName(body.name);
        if (name === undefined) {
          return validationProblem('name', 'Must be 2 to 60 characters long.');
        }
        if (shiftPatterns.some((p) => p.name === name && p.id !== pattern.id)) {
          return conflict('A shift pattern with this name already exists.');
        }
        pattern.name = name;
      }
      if (body.startTime !== undefined) {
        if (!SHIFT_TIME.test(body.startTime)) {
          return validationProblem('startTime', 'Must be a time like 06:00 or 18:30.');
        }
        pattern.startTime = body.startTime;
      }
      if (body.endTime !== undefined) {
        if (!SHIFT_TIME.test(body.endTime)) {
          return validationProblem('endTime', 'Must be a time like 06:00 or 18:30.');
        }
        pattern.endTime = body.endTime;
      }
      if (pattern.startTime === pattern.endTime) {
        return validationProblem('endTime', 'The end time cannot equal the start time.');
      }
      pattern.crossesMidnight = pattern.endTime <= pattern.startTime;
      pattern.updatedAt = new Date().toISOString();
      return HttpResponse.json<ShiftPattern>(pattern);
    },
  ),
];
