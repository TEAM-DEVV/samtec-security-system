import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { PayrollRunPage } from './payroll-run-page';

// The mock's two runs (src/mocks/data/payroll.ts). Both were prepared by the
// payroll officer, which is what makes the "who may decide" cases below work.
const WAITING_FOR_APPROVAL = '01927c3e-bbbb-7000-8000-000000000002';
const ALREADY_PAID = '01927c3e-bbbb-7000-8000-000000000001';

function renderRunPage(runId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/payroll/runs/:runId" element={<PayrollRunPage />} />
      <Route path={routes.payroll} element={<p>Payroll</p>} />
      <Route path="/employees/:employeeId" element={<p>Employee page</p>} />
    </Routes>,
    { route: routes.payrollRun(runId) },
  );
}

/**
 * This page exists to make clear who may decide what, so most of these
 * tests are about which decision is offered to whom.
 */
describe('PayrollRunPage', () => {
  it('shows what a run pays, in cedis', async () => {
    await signInForTests('hr@samtec.example');
    renderRunPage(ALREADY_PAID);

    // Waits for the figures, not just the labels: a card shows a dash until the
    // run has loaded, and asserting on the label alone would pass either way.
    const amounts = await screen.findAllByText(/GH₵\s[\d,]+\.\d{2}/);
    expect(amounts.length).toBeGreaterThan(0);
    expect(screen.getByText('People paid')).toBeInTheDocument();
    expect(screen.getByText('Owed to the state')).toBeInTheDocument();
  });

  it('offers the bank file once a run has been approved, and says it is recorded', async () => {
    await signInForTests('hr@samtec.example');
    renderRunPage(ALREADY_PAID);

    expect(
      await screen.findByRole('button', { name: /Download the bank file/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/recorded against your name/)).toBeInTheDocument();
  });

  it('offers the payment receipt once a run is paid, and says what it is', async () => {
    await signInForTests('hr@samtec.example');
    renderRunPage(ALREADY_PAID);

    expect(
      await screen.findByRole('button', { name: /Payment receipt \(PDF\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/company's own record that these salaries were paid/),
    ).toBeInTheDocument();
  });

  it('does not offer the payment receipt for a run that is only locked, not yet paid', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderRunPage(WAITING_FOR_APPROVAL);

    // Approve it: this run moves from PENDING_APPROVAL to LOCKED, not PAID.
    await user.click(await screen.findByRole('button', { name: /Approve and make the payslips/ }));

    expect(
      await screen.findByRole('button', { name: /Download the bank file/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Payment receipt/ })).not.toBeInTheDocument();
  });

  it('tells a payroll officer that deciding is not theirs to do', async () => {
    await signInForTests('hr@samtec.example');
    renderRunPage(WAITING_FOR_APPROVAL);

    expect(await screen.findByText(/An administrator decides about a run/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send it back/ })).not.toBeInTheDocument();
  });

  it('lets an administrator who did not prepare it approve or send it back', async () => {
    await signInForTests('admin@samtec.example');
    renderRunPage(WAITING_FOR_APPROVAL);

    expect(
      await screen.findByRole('button', { name: /Approve and make the payslips/ }),
    ).toBeInTheDocument();
    // A rejection needs a reason, so the button starts disabled.
    expect(screen.getByRole('button', { name: /Send it back/ })).toBeDisabled();
  });

  it('lists every line with the figures a worker would check', async () => {
    await signInForTests('hr@samtec.example');
    renderRunPage(ALREADY_PAID);

    expect(await screen.findByRole('columnheader', { name: 'Basic' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Income tax' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Days' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Overtime' })).toBeInTheDocument();
  });

  it('explains a run that has not been loaded, rather than showing an empty page', async () => {
    await signInForTests('hr@samtec.example');
    renderRunPage('01927c3e-bbbb-7000-8000-000000000999');

    expect(await screen.findByText(/This run could not be loaded/)).toBeInTheDocument();
  });

  it('links a worker left out of the run to their own page, so the fix is one click away', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    // Selorm (SMT-00010) is hired on 8 September and deliberately has no pay
    // terms, so only the September run — WAITING_FOR_APPROVAL — excludes him;
    // he had not started yet when the August run was calculated.
    renderRunPage(WAITING_FOR_APPROVAL);

    expect(
      await screen.findByText('No pay terms on file — add them before the next run'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Selorm Agbeko' }));

    expect(await screen.findByText('Employee page')).toBeInTheDocument();
  });
});
