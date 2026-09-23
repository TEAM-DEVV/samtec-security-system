import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { LiveBoardPage } from './live-board-page';

describe('LiveBoardPage', () => {
  it('shows an administrator every punch with its method, the flagged ones marked', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<LiveBoardPage />);

    // Kiosk punches (face, then fingerprint) and terminal punches both appear.
    expect((await screen.findAllByText('Face, then fingerprint')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Fingerprint').length).toBeGreaterThan(0);
    // A full page: the header row plus fifty punches.
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getByRole('status')).toHaveTextContent(/^Live/);
    // A co-signed punch says, in text too, that it does not prove who was there.
    expect(screen.getAllByText('(does not prove who was there)').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Kwame Kofi Mensah' }).length).toBeGreaterThan(0);
  });

  it('pauses the refresh on older pages', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<LiveBoardPage />);
    await screen.findAllByText('Fingerprint');

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Paused');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Live');
  });

  it('keeps the last punches on screen when a refresh fails', async () => {
    await signInForTests('admin@samtec.example');
    const { queryClient } = renderWithProviders(<LiveBoardPage />);
    await screen.findAllByText('Fingerprint');

    server.use(
      http.get(
        `${env.apiBaseUrl}/attendance/punches`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Service Unavailable',
              status: 503,
              detail: 'The database is not available.',
              traceId: 'trace-test-board',
            },
            { status: 503 },
          ),
        { once: true },
      ),
    );
    await queryClient.refetchQueries();

    expect(await screen.findByText('The board could not refresh')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.queryByText('The board could not be loaded')).not.toBeInTheDocument();
  });

  it('filters by site', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<LiveBoardPage />);
    await screen.findAllByText('Fingerprint');

    const site = await screen.findByLabelText('Site');
    await user.selectOptions(site, screen.getByRole('option', { name: /TEM-01/ }));

    expect((await screen.findAllByRole('cell', { name: /Harbour Road/ })).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole('cell', { name: /Ridge Towers/ })).not.toBeInTheDocument();
  });

  it('shows a supervisor only punches at their own site', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<LiveBoardPage />);

    expect((await screen.findAllByRole('cell', { name: /Ridge Towers/ })).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole('cell', { name: /East Legon/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: /Harbour Road/ })).not.toBeInTheDocument();
  });
});
