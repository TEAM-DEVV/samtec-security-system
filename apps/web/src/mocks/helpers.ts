import type { ProblemDetails } from '@samtec/contracts';
import { type DefaultBodyType, HttpResponse } from 'msw';
import { env } from '@/lib/env';

/** The full address of an API path, for example `apiUrl('/health')`. */
export function apiUrl(path: string): string {
  return `${env.apiBaseUrl}${path}`;
}

/** Every body a handler may return: its success shape, or a Problem Details error. */
export type OrProblem<Body extends DefaultBodyType> = Body | ProblemDetails;

/** A Problem Details error response, with a fresh trace ID like the real API sends. */
export function problemResponse(
  problem: Omit<ProblemDetails, 'traceId'>,
  extraHeaders: Record<string, string> = {},
): HttpResponse<ProblemDetails> {
  return HttpResponse.json<ProblemDetails>(
    { ...problem, traceId: crypto.randomUUID() },
    {
      status: problem.status,
      headers: { 'Content-Type': 'application/problem+json', ...extraHeaders },
    },
  );
}

export function validationProblem(path: string, message: string): HttpResponse<ProblemDetails> {
  return problemResponse({
    type: 'urn:samtec:problem:validation-error',
    title: 'Validation failed',
    status: 400,
    detail: 'One or more fields are invalid.',
    errors: [{ path, message }],
  });
}

export function unauthorized(detail: string): HttpResponse<ProblemDetails> {
  return problemResponse({ type: 'about:blank', title: 'Unauthorized', status: 401, detail });
}

export function notFound(detail: string): HttpResponse<ProblemDetails> {
  return problemResponse({ type: 'about:blank', title: 'Not Found', status: 404, detail });
}

export function conflict(detail: string): HttpResponse<ProblemDetails> {
  return problemResponse({ type: 'about:blank', title: 'Conflict', status: 409, detail });
}

/** A 429 with the same wording and `Retry-After` header as the real API's rate limit. */
export function tooManyRequests(waitSeconds: number): HttpResponse<ProblemDetails> {
  return problemResponse(
    {
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: `Too many attempts. Try again in ${waitSeconds} seconds.`,
    },
    { 'Retry-After': String(waitSeconds) },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a value shaped like a UUID, the format of every SAMTEC ID. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** True when `value` is one of the allowed `values`, such as a known status. */
export function isOneOf<Value extends string>(
  values: readonly Value[],
  value: string,
): value is Value {
  return values.some((allowed) => allowed === value);
}

/** Reads a text field from a JSON request body. Undefined when it is missing or not text. */
export function textField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(body, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads `limit` the way the real API does: a whole number from 1 to 100, or 25
 * when it is left out. Returns undefined for anything else.
 */
export function readLimit(query: URLSearchParams): number | undefined {
  const raw = query.get('limit');
  if (raw === null) {
    return 25;
  }
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : undefined;
}

/**
 * Cursor pagination, like the real API. The cursor is an opaque string; here it
 * simply encodes the position of the next item. Returns undefined for a bad cursor.
 */
export function pageOf<Item>(
  all: readonly Item[],
  limit: number,
  cursor: string | null,
): { items: Item[]; nextCursor: string | null } | undefined {
  let offset = 0;
  if (cursor !== null) {
    if (cursor.length > 200) {
      return undefined;
    }
    try {
      offset = Number.parseInt(atob(cursor), 10);
    } catch {
      return undefined;
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return undefined;
    }
  }

  const end = offset + limit;
  return { items: all.slice(offset, end), nextCursor: end < all.length ? btoa(String(end)) : null };
}
