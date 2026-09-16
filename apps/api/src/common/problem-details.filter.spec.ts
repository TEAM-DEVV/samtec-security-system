import {
  type ArgumentsHost,
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeForLogs,
  ProblemDetailsFilter,
  toProblemDetails,
} from './problem-details.filter.js';

describe('toProblemDetails', () => {
  it('keeps the status and message of an expected HTTP error', () => {
    const problem = toProblemDetails(
      new NotFoundException('No employee exists with this ID.'),
      '/api/v1/employees/123',
      'trace-1',
    );

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No employee exists with this ID.',
      instance: '/api/v1/employees/123',
      traceId: 'trace-1',
    });
  });

  it('hides the details of unexpected errors from the client', () => {
    const problem = toProblemDetails(
      new Error('connect failed for postgresql://admin:hunter2@db.internal/samtec'),
      '/api/v1/health',
      'trace-2',
    );

    expect(problem.status).toBe(500);
    expect(problem.title).toBe('Internal Server Error');
    expect(JSON.stringify(problem)).not.toContain('hunter2');
  });

  it('lists every invalid field for validation errors', () => {
    const problem = toProblemDetails(
      new BadRequestException({
        message: [
          { path: ['phone'], message: 'Must look like +233241234567.' },
          { path: [{ key: 'address' }, 'city'], message: 'Required.' },
        ],
      }),
      '/api/v1/employees',
      'trace-3',
    );

    expect(problem.type).toBe('urn:samtec:problem:validation-error');
    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([
      { path: 'phone', message: 'Must look like +233241234567.' },
      { path: 'address.city', message: 'Required.' },
    ]);
  });

  it('marks conflicts with the SAMTEC conflict type, as the contract promises', () => {
    const problem = toProblemDetails(
      new ConflictException('An employee with this Ghana Card number is already registered.'),
      '/api/v1/employees',
      'trace-4',
    );

    expect(problem).toMatchObject({
      type: 'urn:samtec:problem:conflict',
      title: 'Conflict',
      status: 409,
    });
  });

  it('keeps the 4xx status of errors raised while reading the request body', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    const problem = toProblemDetails(tooLarge, '/api/v1/employees', 'trace-5');

    expect(problem).toMatchObject({
      status: 413,
      title: 'Payload Too Large',
      detail: 'The request body is too large.',
    });
  });
});

describe('describeForLogs', () => {
  it('keeps the error name and code but never the message', () => {
    const error = Object.assign(
      new Error('Unique constraint failed for ghana_card_number GHA-123456789-0'),
      { code: 'P2002' },
    );

    const description = describeForLogs(error);

    expect(description).toContain('P2002');
    expect(description).not.toContain('GHA-123456789-0');
  });
});

describe('ProblemDetailsFilter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never writes personal data from the URL or the error message to the logs', () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const json = vi.fn();
    const response = {
      locals: { requestId: 'trace-12345678' },
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      json,
    };
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/employees?search=GHA-123456789-0',
      path: '/employees',
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;

    new ProblemDetailsFilter().catch(
      Object.assign(new Error('Lookup failed for GHA-123456789-0'), { code: 'P2025' }),
      host,
    );

    const logged = JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls]);
    expect(logged).toContain('trace-12345678');
    expect(logged).not.toContain('GHA-123456789-0');
    expect(JSON.stringify(json.mock.calls)).not.toContain('GHA-123456789-0');
  });
});
