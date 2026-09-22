import type { ProblemDetails } from '@samtec/contracts';
import { describe, expect, it } from 'vitest';
import { describeApiError, isWorthRetrying } from './problem';

const notFound: ProblemDetails = {
  type: 'about:blank',
  title: 'Not Found',
  status: 404,
  detail: 'No employee exists with this ID.',
  traceId: 'trace-404',
};

describe('describeApiError', () => {
  it('shows the detail and trace ID of an API error', () => {
    expect(describeApiError(notFound)).toEqual({
      message: 'No employee exists with this ID.',
      traceId: 'trace-404',
    });
  });

  it('shows the first field problem of a validation error', () => {
    const validationError: ProblemDetails = {
      type: 'urn:samtec:problem:validation-error',
      title: 'Validation failed',
      status: 400,
      detail: 'One or more fields are invalid.',
      traceId: 'trace-400',
      errors: [{ path: 'search', message: 'Search must be 2 to 100 characters long.' }],
    };

    expect(describeApiError(validationError).message).toBe(
      'Search must be 2 to 100 characters long.',
    );
  });

  it('explains a network error, which has no Problem Details body', () => {
    expect(describeApiError(new TypeError('Failed to fetch')).message).toMatch(/Could not reach/);
  });
});

describe('isWorthRetrying', () => {
  it('retries when the API could not be reached', () => {
    expect(isWorthRetrying(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('retries server errors', () => {
    expect(isWorthRetrying({ ...notFound, status: 503, title: 'Service Unavailable' })).toBe(true);
  });

  it('does not retry client errors, which would fail again', () => {
    expect(isWorthRetrying(notFound)).toBe(false);
  });

  it('retries a rate limit, which passes once the wait is over', () => {
    expect(isWorthRetrying({ ...notFound, status: 429, title: 'Too Many Requests' })).toBe(true);
  });
});
