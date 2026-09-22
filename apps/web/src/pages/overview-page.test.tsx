import type { HealthResponse } from '@samtec/contracts';
import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { OverviewPage } from './overview-page';

describe('OverviewPage', () => {
  it('greets the signed-in person by first name and offers the pages their role may open', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByRole('heading', { name: /, Yaw$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Employees/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sites/ })).toBeInTheDocument();
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
  });

  it('offers a guard no pages they may not open', async () => {
    await signInForTests('guard@samtec.example');

    renderWithProviders(<OverviewPage />);

    await screen.findByRole('heading', { name: /, Kwame$/ });
    expect(screen.queryByRole('link', { name: /Employees/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Sites/ })).not.toBeInTheDocument();
    expect(screen.getByText('Guard')).toBeInTheDocument();
  });

  it('shows that the API and database are up', async () => {
    await signInForTests();

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByText('API and database are up')).toBeInTheDocument();
  });

  it('says the API needs attention when the latest check fails', async () => {
    await signInForTests();
    server.use(
      http.get(`${env.apiBaseUrl}/health`, () =>
        HttpResponse.json<HealthResponse>(
          { status: 'degraded', time: '2026-09-15T08:30:00Z', checks: { database: 'down' } },
          { status: 503 },
        ),
      ),
    );

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByText('The API needs attention')).toBeInTheDocument();
  });
});
