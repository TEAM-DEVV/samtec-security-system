import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { SiteDetailPage } from './site-detail-page';

const ACC_01 = '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01'; // Ridge Towers, the supervisor's own site
const ACC_02 = '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c02'; // East Legon, a different site
const NOBODY = '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c99';

function renderDetailPage(siteId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/sites/:siteId" element={<SiteDetailPage />} />
      <Route path={routes.sites} element={<p>Site list</p>} />
    </Routes>,
    { route: routes.site(siteId) },
  );
}

describe('SiteDetailPage', () => {
  it('shows the details, posts, devices and workers for an administrator', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage(ACC_01);

    expect(
      await screen.findByRole('heading', { name: 'Ridge Towers Office Complex' }),
    ).toBeInTheDocument();
    expect(screen.getByText('ACC-01')).toBeInTheDocument();
    expect(screen.getByText('Ridge Towers Management Ltd')).toBeInTheDocument();
    // The city and the region's label are sibling text split across two
    // nodes, so a `getByText` match would not see the whole phrase as one
    // element; read the term's own definition node instead.
    const location = screen.getByText('Location').nextElementSibling;
    expect(location).toHaveTextContent('Accra, Greater Accra');

    // Posts.
    expect(await screen.findByText('Main Gate')).toBeInTheDocument();
    expect(screen.getByText('Reception')).toBeInTheDocument();

    // Devices (ADMIN only).
    expect(await screen.findByRole('link', { name: 'Mock terminal ACC-01' })).toBeInTheDocument();

    // Workers, with the staff number linking to the employee page.
    const kwame = await screen.findByRole('link', { name: 'SMT-00001' });
    expect(kwame).toHaveAttribute('href', routes.employee('01927c3e-5a4b-7c8d-9e0f-000000000001'));
    const kwameRow = kwame.closest('tr');
    if (!kwameRow) {
      throw new Error('Expected the staff number link to sit inside a table row.');
    }
    // Scoped to Kwame's own row: the posts table above also has a "Main
    // Gate" entry, and matching loosely would find both.
    expect(within(kwameRow).getByText('Kwame Kofi Mensah')).toBeInTheDocument();
    // Kwame is a guard on the main gate's day shift (src/mocks/data/employees.ts).
    // Plain substring checks: the post and the shift sit in sibling text
    // nodes of one cell, so a `getByText` query would match both the cell
    // and its own nested span.
    expect(kwameRow.textContent).toContain('Main Gate');
    expect(kwameRow.textContent).toContain('Day Shift');
  });

  it('offers Edit to HR, with no devices section (ADMIN only)', async () => {
    await signInForTests('hr@samtec.example');

    renderDetailPage(ACC_01);

    expect(
      await screen.findByRole('heading', { name: 'Ridge Towers Office Complex' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      routes.editSite(ACC_01),
    );
    expect(screen.queryByText('Devices')).not.toBeInTheDocument();
  });

  it('offers no Edit button and no devices section to a supervisor', async () => {
    await signInForTests('supervisor@samtec.example');

    renderDetailPage(ACC_01);

    expect(
      await screen.findByRole('heading', { name: 'Ridge Towers Office Complex' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText('Devices')).not.toBeInTheDocument();
  });

  it('says nothing was found for a site this supervisor is not posted to', async () => {
    await signInForTests('supervisor@samtec.example');

    renderDetailPage(ACC_02);

    expect(await screen.findByText('No site found')).toBeInTheDocument();
  });

  it('says nothing was found for an unknown ID', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage(NOBODY);

    expect(await screen.findByText('No site found')).toBeInTheDocument();
  });

  it('explains a server error with a trace ID and a way to try again', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(
        `${env.apiBaseUrl}/sites/:siteId`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              detail: 'The database is not available.',
              traceId: 'trace-test-site-detail',
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );

    renderDetailPage(ACC_01);

    expect(await screen.findByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByText('Trace ID: trace-test-site-detail')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Ridge Towers Office Complex' }),
    ).toBeInTheDocument();
  });

  it('says plainly when nobody is posted and nothing is installed yet', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/sites/:siteId/posts`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${env.apiBaseUrl}/devices`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${env.apiBaseUrl}/employees`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );

    renderDetailPage(ACC_01);

    expect(await screen.findByText('No posts at this site yet.')).toBeInTheDocument();
    expect(screen.getByText('No devices at this site yet.')).toBeInTheDocument();
    expect(screen.getByText('Nobody is posted here yet.')).toBeInTheDocument();
  });
});
