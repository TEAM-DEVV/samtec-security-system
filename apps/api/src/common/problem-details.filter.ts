import { STATUS_CODES } from 'node:http';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ProblemDetails, ValidationIssue } from '@samtec/contracts';
import type { Request, Response } from 'express';
import { getRequestId } from './request-id.middleware.js';

/**
 * Turns every error into a Problem Details response (RFC 9457): the error
 * format promised in the API contract.
 *
 * - Expected errors (Nest `HttpException`s such as `NotFoundException`) keep
 *   their status code and message.
 * - Errors raised while reading the request, such as a body that is too large,
 *   keep their 4xx status with a generic message.
 * - Unexpected errors become a generic 500. Stack traces and internal messages
 *   are never sent to the client, because they help attackers.
 *
 * Logging rules: never log request bodies, query strings or error messages,
 * because they can contain personal data such as Ghana Card numbers.
 * - 4xx: one warning line with the method, path, status and traceId.
 * - 5xx: the same, plus the error's name, its code and its stack frames.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // The path without its query string, so search terms never appear in
    // error responses or logs.
    const path = request.originalUrl.split('?')[0] ?? request.path;
    const problem = toProblemDetails(exception, path, getRequestId(response));

    // Nest's "route not found" message repeats the full URL, query string included.
    if (problem.detail !== undefined) {
      problem.detail = problem.detail.replaceAll(request.originalUrl, path);
    }

    // A rate-limited caller is told how long to wait (see RateLimitException).
    if (
      'retryAfterSeconds' in (exception as object) &&
      typeof (exception as { retryAfterSeconds: unknown }).retryAfterSeconds === 'number'
    ) {
      response.setHeader(
        'Retry-After',
        String((exception as { retryAfterSeconds: number }).retryAfterSeconds),
      );
    }

    const summary = `${request.method} ${path} answered ${problem.status} (traceId ${problem.traceId})`;
    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${summary}: ${describeForLogs(exception)}`);
    } else {
      this.logger.warn(summary);
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }
}

/** Builds the Problem Details body for anything that was thrown. */
export function toProblemDetails(
  exception: unknown,
  instance: string,
  traceId: string,
): ProblemDetails {
  if (exception instanceof HttpException) {
    return fromHttpException(exception, instance, traceId);
  }

  const clientStatus = clientErrorStatus(exception);
  if (clientStatus !== undefined) {
    return {
      type: 'about:blank',
      title: titleFor(clientStatus),
      status: clientStatus,
      detail: CLIENT_ERROR_DETAILS[clientStatus] ?? 'The request could not be read.',
      instance,
      traceId,
    };
  }

  return {
    type: 'about:blank',
    title: titleFor(HttpStatus.INTERNAL_SERVER_ERROR),
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    detail: 'Something went wrong on our side. Please share the traceId with the SAMTEC team.',
    instance,
    traceId,
  };
}

/**
 * Describes an error for the logs: its name, its code (for example Prisma's
 * `P2002`) and its stack frames. Never its message, which can contain personal data.
 */
export function describeForLogs(exception: unknown): string {
  if (!(exception instanceof Error)) {
    return 'a value that is not an Error was thrown';
  }
  const code =
    'code' in exception &&
    (typeof exception.code === 'string' || typeof exception.code === 'number')
      ? ` (code ${exception.code})`
      : '';
  const frames = (exception.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  return `${exception.name}${code}\n${frames}`;
}

const CLIENT_ERROR_DETAILS: Record<number, string> = {
  413: 'The request body is too large.',
  415: 'The request body uses a format or character set the API does not accept.',
};

function fromHttpException(
  exception: HttpException,
  instance: string,
  traceId: string,
): ProblemDetails {
  const status = exception.getStatus();
  const { detail, errors } = describeHttpException(exception);

  if (errors.length > 0) {
    return {
      type: 'urn:samtec:problem:validation-error',
      title: 'Validation failed',
      status,
      detail,
      instance,
      traceId,
      errors,
    };
  }

  if (status === HttpStatus.CONFLICT) {
    return {
      type: 'urn:samtec:problem:conflict',
      title: 'Conflict',
      status,
      detail,
      instance,
      traceId,
    };
  }

  return { type: 'about:blank', title: titleFor(status), status, detail, instance, traceId };
}

/**
 * Errors thrown before our code runs, such as body-parser's "request entity
 * too large", carry their own 4xx `status`. Returns it, or undefined.
 */
function clientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null || !('status' in exception)) {
    return undefined;
  }
  const { status } = exception;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function titleFor(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/**
 * A Nest exception carries either a plain string or an object such as
 * `{ message: 'Not Found' }`, or `{ message: [...] }` for validation errors.
 */
function describeHttpException(exception: HttpException): {
  detail: string;
  errors: ValidationIssue[];
} {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return { detail: body, errors: [] };
  }

  const message = 'message' in body ? body.message : undefined;
  if (Array.isArray(message)) {
    return {
      detail: 'One or more fields are invalid.',
      errors: message.map((item) => toValidationIssue(item)),
    };
  }

  return { detail: typeof message === 'string' ? message : exception.message, errors: [] };
}

function toValidationIssue(item: unknown): ValidationIssue {
  if (typeof item === 'string') {
    return { path: '', message: item };
  }
  if (typeof item === 'object' && item !== null) {
    const path = 'path' in item ? formatPath(item.path) : '';
    const message =
      'message' in item && typeof item.message === 'string' ? item.message : 'Invalid value.';
    return { path, message };
  }
  return { path: '', message: 'Invalid value.' };
}

/** Turns a path such as ['address', 'city'] into 'address.city'. */
function formatPath(path: unknown): string {
  if (typeof path === 'string') {
    return path;
  }
  if (!Array.isArray(path)) {
    return '';
  }
  return path
    .map((segment: unknown) =>
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? String(segment.key)
        : String(segment),
    )
    .join('.');
}
