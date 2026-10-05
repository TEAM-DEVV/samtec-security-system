import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { NewSitePage } from './new-site-page';

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path={routes.newSite} element={<NewSitePage />} />
      <Route path="/sites/:siteId" element={<p>The new site record</p>} />
    </Routes>,
    { route: routes.newSite },
  );
}

/** Fills every required box with something the API accepts. */
async function fillTheForm(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.type(screen.getByLabelText('Code'), code);
  await user.type(screen.getByLabelText('Name'), 'Airport City Office Park');
  await user.type(screen.getByLabelText('Client name'), 'Airport City Properties Ltd');
  await user.selectOptions(screen.getByLabelText('Region'), 'GREATER_ACCRA');
  await user.type(screen.getByLabelText('City'), 'Accra');
}

describe('NewSitePage', () => {
  it('adds a site and opens its new record', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    await fillTheForm(user, 'ACC-09');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    expect(await screen.findByText('The new site record')).toBeInTheDocument();
  });

  it('catches a badly shaped code before sending it', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    await fillTheForm(user, 'accra-9');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    expect(await screen.findByText(/must look like ACC-01/)).toBeInTheDocument();
    // Nothing was sent, so the page did not move on.
    expect(screen.queryByText('The new site record')).not.toBeInTheDocument();
  });

  it('asks for a region before sending the form', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Code'), 'ACC-09');
    await user.type(screen.getByLabelText('Name'), 'Airport City Office Park');
    await user.type(screen.getByLabelText('Client name'), 'Airport City Properties Ltd');
    await user.type(screen.getByLabelText('City'), 'Accra');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    expect(await screen.findByText('Choose a region.')).toBeInTheDocument();
  });

  it("shows the API's own words when the code is already taken", async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    // The first mock site's code (src/mocks/data/sites.ts).
    await fillTheForm(user, 'ACC-01');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });

  it('defaults the status to Active', async () => {
    await signInForTests('hr@samtec.example');
    renderPage();

    expect(screen.getByLabelText<HTMLSelectElement>('Status').value).toBe('ACTIVE');
  });
});
