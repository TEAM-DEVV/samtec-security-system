import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { mockEmployees } from '@/mocks/data/employees';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { EditEmployeePage } from './edit-employee-page';

const ACTIVE = mockEmployees.find((employee) => employee.status === 'ACTIVE');
const LEFT = mockEmployees.find((employee) => employee.status === 'TERMINATED');

function renderPage(employeeId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/employees/:employeeId/edit" element={<EditEmployeePage />} />
      <Route path="/employees/:employeeId" element={<p>Their record</p>} />
    </Routes>,
    { route: routes.editEmployee(employeeId) },
  );
}

describe('EditEmployeePage', () => {
  it('opens filled in with what the record already says', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(ACTIVE?.id ?? '');

    const position = await screen.findByLabelText<HTMLInputElement>('Position');
    expect(position.value).toBe(ACTIVE?.position);
    expect(screen.getByLabelText<HTMLInputElement>('First name').value).toBe(ACTIVE?.firstName);
  });

  it('saves a changed position and goes back to the record', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderPage(ACTIVE?.id ?? '');

    const position = await screen.findByLabelText('Position');
    await user.clear(position);
    await user.type(position, 'Shift Supervisor');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Their record')).toBeInTheDocument();
  });

  it('keeps the Ghana Card number and the start date read-only', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(ACTIVE?.id ?? '');

    const card = await screen.findByLabelText<HTMLInputElement>('Ghana Card number');
    expect(card).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Started on')).toHaveAttribute('readonly');
    // And the page says why, rather than leaving somebody guessing.
    expect(screen.getByText(/identifies this person for life/)).toBeInTheDocument();
  });

  it('refuses to open a form for somebody who has left', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(LEFT?.id ?? '');

    expect(await screen.findByText('This record cannot be changed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Position')).not.toBeInTheDocument();
  });
});
