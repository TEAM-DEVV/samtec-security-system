import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { describeDrift, driftIsSuspect } from '@/lib/attendance';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DevicesPage } from './devices-page';

describe('DevicesPage', () => {
  it('lists every device with its health, flagging a clock that runs fast', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<DevicesPage />);

    expect(await screen.findByRole('link', { name: 'Mock terminal TEM-01' })).toBeInTheDocument();
    expect(screen.getByText('7 min fast · suspect')).toBeInTheDocument();
    expect(screen.getByText('Face kiosk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register device' })).toBeInTheDocument();
  });

  it("links each device's site to the site's own page", async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<DevicesPage />);

    await screen.findByRole('link', { name: 'Mock terminal TEM-01' });
    // Anchored so it never matches the device's own name, which also
    // contains "TEM-01". The site name comes from a second, independent
    // query, so it may resolve after the device list already has.
    const siteLink = await screen.findByRole('link', { name: /^TEM-01 ·/ });
    expect(siteLink).toHaveAttribute('href', routes.site('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c03'));
  });

  it('shows the API error with a way to try again', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/devices`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'The database is not available.',
            traceId: 'trace-test-500',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<DevicesPage />);

    expect(await screen.findByText('Devices could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('describeDrift', () => {
  it('describes a clock in plain words', () => {
    expect(describeDrift(null)).toBe('—');
    expect(describeDrift(0)).toBe('exact');
    expect(describeDrift(2)).toBe('2 s fast');
    expect(describeDrift(-45)).toBe('45 s slow');
    expect(describeDrift(420)).toBe('7 min fast');
  });

  it('flags only a clock more than 5 minutes off', () => {
    expect(driftIsSuspect(null)).toBe(false);
    expect(driftIsSuspect(300)).toBe(false);
    expect(driftIsSuspect(301)).toBe(true);
    expect(driftIsSuspect(-420)).toBe(true);
  });
});
