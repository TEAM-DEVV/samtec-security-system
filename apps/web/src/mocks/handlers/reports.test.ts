import { describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { signInForTests } from '@/test/session';
import { mockSites } from '../data/sites';

const SITE = mockSites[0] as (typeof mockSites)[number];

/** The query every call needs; overridden per test for the bad-rate cases. */
const RATE = { hourlyRatePesewas: 1_500 };

describe('mock client invoice API', () => {
  it('answers a PDF for a real site, a real month and a valid rate', async () => {
    await signInForTests('admin@samtec.example');
    // The body is a PDF, not JSON, so it must be read as text — openapi-fetch
    // defaults to JSON regardless of the response's own Content-Type.
    const answer = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: { path: { siteId: SITE.id, month: '2026-09' }, query: RATE },
      parseAs: 'text',
    });
    expect(answer.response.status).toBe(200);
    expect(answer.response.headers.get('content-type')).toContain('application/pdf');
    expect(answer.response.headers.get('content-disposition')).toBe(
      `attachment; filename="invoice-${SITE.code}-2026-09.pdf"`,
    );
    expect(answer.response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a supervisor, who sees no payroll-shaped figure here either', async () => {
    await signInForTests('supervisor@samtec.example');
    const refused = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: { path: { siteId: SITE.id, month: '2026-09' }, query: RATE },
    });
    expect(refused.response.status).toBe(403);
  });

  it('answers 400 for a site id that is not even shaped like one, the same as GET /sites/:siteId', async () => {
    await signInForTests('admin@samtec.example');
    const answer = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: { path: { siteId: 'not-a-uuid', month: '2026-09' }, query: RATE },
    });
    expect(answer.response.status).toBe(400);
  });

  it('answers 404 for a well-formed id that matches no site', async () => {
    await signInForTests('admin@samtec.example');
    const answer = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: {
        path: { siteId: '01927c3e-0000-7000-8000-000000000000', month: '2026-09' },
        query: RATE,
      },
    });
    expect(answer.response.status).toBe(404);
  });

  it('answers 400 for a month that is not YYYY-MM', async () => {
    await signInForTests('admin@samtec.example');
    const answer = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: { path: { siteId: SITE.id, month: '2026-13' }, query: RATE },
    });
    expect(answer.response.status).toBe(400);
  });

  it('answers 400 for a rate that is zero or not a whole number', async () => {
    await signInForTests('admin@samtec.example');
    const zero = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: {
        path: { siteId: SITE.id, month: '2026-09' },
        query: { hourlyRatePesewas: 0 },
      },
    });
    expect(zero.response.status).toBe(400);

    const fractional = await fetchClient.GET('/sites/{siteId}/invoices/{month}.pdf', {
      params: { path: { siteId: SITE.id, month: '2026-09' }, query: { hourlyRatePesewas: 12.5 } },
    });
    expect(fractional.response.status).toBe(400);
  });
});
