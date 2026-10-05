import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { mockSites } from '@/mocks/data/sites';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { EditSitePage } from './edit-site-page';

const ACC_01 = mockSites.find((site) => site.code === 'ACC-01');

function renderPage(siteId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/sites/:siteId/edit" element={<EditSitePage />} />
      <Route path="/sites/:siteId" element={<p>The site record</p>} />
    </Routes>,
    { route: routes.editSite(siteId) },
  );
}

describe('EditSitePage', () => {
  it('opens filled in with what the record already says', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(ACC_01?.id ?? '');

    const name = await screen.findByLabelText<HTMLInputElement>('Name');
    expect(name.value).toBe(ACC_01?.name);
    expect(screen.getByLabelText<HTMLInputElement>('Client name').value).toBe(ACC_01?.clientName);
    expect(screen.getByLabelText<HTMLInputElement>('Code').value).toBe(ACC_01?.code);
  });

  it('keeps the code read-only, and says why', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(ACC_01?.id ?? '');

    const code = await screen.findByLabelText<HTMLInputElement>('Code');
    expect(code).toHaveAttribute('readonly');
    expect(screen.getByText(/printed on devices and documents/)).toBeInTheDocument();
  });

  it('saves a changed name and goes back to the record', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage(ACC_01?.id ?? '');

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Ridge Towers Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('The site record')).toBeInTheDocument();
  });

  it('sends nothing, and still goes back, when nothing changed', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    const sent: string[] = [];
    const seeRequest = ({ request }: { request: Request }) => {
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
    };
    server.events.on('request:start', seeRequest);
    try {
      renderPage(ACC_01?.id ?? '');
      await screen.findByLabelText('Name');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText('The site record')).toBeInTheDocument();
      expect(sent).not.toContain(`PATCH /api/v1/sites/${ACC_01?.id}`);
    } finally {
      server.events.removeListener('request:start', seeRequest);
    }
  });

  it("shows the API's own words when switching off is refused", async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage(ACC_01?.id ?? '');

    await screen.findByLabelText('Name');
    await user.selectOptions(screen.getByLabelText('Status'), 'INACTIVE');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/before making it inactive/)).toBeInTheDocument();
    expect(screen.queryByText('The site record')).not.toBeInTheDocument();
  });
});
