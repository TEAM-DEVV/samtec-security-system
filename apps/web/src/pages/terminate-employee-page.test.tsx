import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { mockEmployees } from '@/mocks/data/employees';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { TerminateEmployeePage } from './terminate-employee-page';

/** Somebody still working, whose employment can therefore be ended. */
const STILL_HERE = mockEmployees.find((employee) => employee.status === 'SUSPENDED');
const ALREADY_LEFT = mockEmployees.find((employee) => employee.status === 'TERMINATED');

function renderPage(employeeId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/employees/:employeeId/terminate" element={<TerminateEmployeePage />} />
      <Route path="/employees/:employeeId" element={<p>Their record</p>} />
    </Routes>,
    { route: routes.terminateEmployee(employeeId) },
  );
}

/**
 * Ending somebody's employment is the one thing on the dashboard that cannot be
 * undone, so these tests are mostly about the ways it refuses.
 */
describe('TerminateEmployeePage', () => {
  it('says plainly what it does and does not do', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(STILL_HERE?.id ?? '');

    expect(await screen.findByText('What this does, and what it does not')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
  });

  it('will not act until the staff number is typed', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage(STILL_HERE?.id ?? '');

    await screen.findByLabelText('Last working day');
    await user.click(screen.getByRole('button', { name: 'Record that they have left' }));

    expect(
      await screen.findByText(
        `Type ${STILL_HERE?.staffNumber} to confirm this is the right person.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Their record')).not.toBeInTheDocument();
  });

  it('asks for a note when the reason is Other', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage(STILL_HERE?.id ?? '');

    await user.selectOptions(await screen.findByLabelText('Reason'), 'OTHER');
    await user.type(screen.getByLabelText(/to confirm/), STILL_HERE?.staffNumber ?? '');
    await user.click(screen.getByRole('button', { name: 'Record that they have left' }));

    expect(await screen.findByText(/Explain the reason in the note/)).toBeInTheDocument();
  });

  it('records it once everything is filled in', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage(STILL_HERE?.id ?? '');

    await user.selectOptions(await screen.findByLabelText('Reason'), 'RESIGNED');
    await user.type(screen.getByLabelText(/to confirm/), STILL_HERE?.staffNumber ?? '');
    await user.click(screen.getByRole('button', { name: 'Record that they have left' }));

    expect(await screen.findByText('Their record')).toBeInTheDocument();
  });

  it('offers no form for somebody who has already left', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(ALREADY_LEFT?.id ?? '');

    expect(await screen.findByText('This has already been recorded')).toBeInTheDocument();
    expect(screen.queryByLabelText('Last working day')).not.toBeInTheDocument();
  });
});
