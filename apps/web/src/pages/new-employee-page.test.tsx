import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { NewEmployeePage } from './new-employee-page';

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path={routes.newEmployee} element={<NewEmployeePage />} />
      <Route path="/employees/:employeeId" element={<p>The new record</p>} />
    </Routes>,
    { route: routes.newEmployee },
  );
}

/** Fills every required box with something the API accepts. */
async function fillTheForm(user: ReturnType<typeof userEvent.setup>, card: string) {
  await user.type(screen.getByLabelText('First name'), 'Yaw');
  await user.type(screen.getByLabelText('Last name'), 'Asante');
  await user.clear(screen.getByLabelText('Phone'));
  await user.type(screen.getByLabelText('Phone'), '+233241234567');
  await user.type(screen.getByLabelText('Position'), 'Security Guard');
  await user.type(screen.getByLabelText('Ghana Card number'), card);
}

describe('NewEmployeePage', () => {
  it('registers somebody and opens their new record', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    await fillTheForm(user, 'GHA-987654321-0');
    await user.click(screen.getByRole('button', { name: 'Register employee' }));

    expect(await screen.findByText('The new record')).toBeInTheDocument();
  });

  it('catches a phone number in the wrong shape before sending it', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('First name'), 'Yaw');
    await user.type(screen.getByLabelText('Last name'), 'Asante');
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '0241234567');
    await user.type(screen.getByLabelText('Position'), 'Security Guard');
    await user.type(screen.getByLabelText('Ghana Card number'), 'GHA-987654322-0');
    await user.click(screen.getByRole('button', { name: 'Register employee' }));

    expect(await screen.findByText(/must be \+233 followed by 9 digits/)).toBeInTheDocument();
    // Nothing was sent, so the page did not move on.
    expect(screen.queryByText('The new record')).not.toBeInTheDocument();
  });

  it("shows the API's own words when the Ghana Card is already registered", async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    // The first mock employee's card number (src/mocks/data/employees.ts).
    await fillTheForm(user, 'GHA-000000001-1');
    await user.click(screen.getByRole('button', { name: 'Register employee' }));

    expect(await screen.findByText(/already registered/)).toBeInTheDocument();
  });

  it('asks for a site before it offers a post or a shift', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByLabelText('Post at the site')).not.toBeInTheDocument();
    // The drop-down fills from the API first.
    await screen.findByRole('option', { name: /Ridge Towers/ });
    const site = screen.getByLabelText<HTMLSelectElement>('Posted to');
    await user.selectOptions(site, site.options[1]?.value ?? '');

    expect(await screen.findByLabelText('Post at the site')).toBeInTheDocument();
    expect(screen.getByLabelText('Shift worked')).toBeInTheDocument();
  });
});
