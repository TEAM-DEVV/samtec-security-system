import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { mockSites } from '@/mocks/data/sites';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { SitesPage } from './sites-page';

describe('SitesPage', () => {
  it('lists sites from the API with their location and guard count', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText('Ridge Towers Office Complex')).toBeInTheDocument();
    expect(screen.getByText('ACC-01')).toBeInTheDocument();
    expect(screen.getByText('Ridge Towers Management Ltd')).toBeInTheDocument();
    // The region is shown by its label, not the API's code, next to the city.
    expect(screen.getByRole('cell', { name: 'Kumasi, Ashanti' })).toBeInTheDocument();
    // The status badge in the table (the drop-down also has an "Inactive" option).
    expect(screen.getByRole('cell', { name: 'Inactive' })).toBeInTheDocument();
  });

  it('moves to the next page and back', async () => {
    await signInForTests('admin@samtec.example');
    // Two small pages, so the pagination buttons have something to do.
    server.use(
      http.get(`${env.apiBaseUrl}/sites`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        const [first, second] = mockSites;
        return cursor === null
          ? HttpResponse.json({ items: [first], nextCursor: 'page-2' })
          : HttpResponse.json({ items: [second], nextCursor: null });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<SitesPage />);
    await screen.findByText('Ridge Towers Office Complex');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('East Legon Residences')).toBeInTheDocument();
    expect(screen.queryByText('Ridge Towers Office Complex')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Ridge Towers Office Complex')).toBeInTheDocument();
    expect(screen.queryByText('East Legon Residences')).not.toBeInTheDocument();
  });

  it('shows a supervisor only their own site', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText('Ridge Towers Office Complex')).toBeInTheDocument();
    expect(screen.queryByText('Adum Retail Centre')).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<SitesPage />);
    await screen.findByText('Ridge Towers Office Complex');

    await user.selectOptions(screen.getByLabelText('Status'), 'INACTIVE');

    expect(await screen.findByText('Pedu Junction Bank Branch')).toBeInTheDocument();
    expect(screen.queryByText('Ridge Towers Office Complex')).not.toBeInTheDocument();
  });

  it('filters by region, and says when nothing matches', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<SitesPage />);
    await screen.findByText('Ridge Towers Office Complex');

    await user.selectOptions(screen.getByLabelText('Region'), 'ASHANTI');
    expect(await screen.findByText('Adum Retail Centre')).toBeInTheDocument();
    expect(screen.queryByText('Ridge Towers Office Complex')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Region'), 'VOLTA');
    expect(await screen.findByText('No sites match these filters.')).toBeInTheDocument();
  });

  it('says there is nothing to show yet when no filter is set and the list is empty', async () => {
    await signInForTests('supervisor@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/sites`, () => HttpResponse.json({ items: [], nextCursor: null })),
    );

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText('No sites to show yet.')).toBeInTheDocument();
  });

  it('explains the problem when the API fails', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/sites`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'The database is not available.',
            traceId: 'trace-test-sites',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByText('Trace ID: trace-test-sites')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
