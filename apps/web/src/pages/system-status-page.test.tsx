import type { HealthResponse, ProblemDetails } from '@samtec/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { SystemStatusPage } from './system-status-page';

const databaseDown = () =>
  HttpResponse.json<HealthResponse>(
    { status: 'degraded', time: '2026-09-15T08:30:00Z', checks: { database: 'down' } },
    { status: 503 },
  );

describe('SystemStatusPage', () => {
  it('shows the API and the database as working', async () => {
    renderWithProviders(<SystemStatusPage />);

    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows the database as down when the API reports a problem', async () => {
    server.use(http.get(`${env.apiBaseUrl}/health`, databaseDown));

    renderWithProviders(<SystemStatusPage />);

    expect(await screen.findByText('Down')).toBeInTheDocument();
    expect(screen.getByText('Reachable')).toBeInTheDocument();
  });

  it('shows the latest result after checking again, never an older success', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SystemStatusPage />);
    expect(await screen.findByText('Connected')).toBeInTheDocument();

    server.use(http.get(`${env.apiBaseUrl}/health`, databaseDown));
    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await screen.findByText('Down')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('explains what to check when the API cannot be reached', async () => {
    server.use(http.get(`${env.apiBaseUrl}/health`, () => HttpResponse.error()));

    renderWithProviders(<SystemStatusPage />);

    expect(await screen.findByText('The dashboard cannot reach the API')).toBeInTheDocument();
    expect(screen.getByText('Not reachable')).toBeInTheDocument();
    expect(screen.getByText('CORS_ORIGINS')).toBeInTheDocument();
  });

  it('shows the message and trace ID when the API answers with an error', async () => {
    server.use(
      http.get(`${env.apiBaseUrl}/health`, () =>
        HttpResponse.json<ProblemDetails>(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'Something went wrong on our side.',
            traceId: 'trace-health-1',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<SystemStatusPage />);

    expect(await screen.findByText('The API answered with an error')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong on our side.')).toBeInTheDocument();
    expect(screen.getByText('Trace ID: trace-health-1')).toBeInTheDocument();
  });
});
