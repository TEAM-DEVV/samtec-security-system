import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { mockEmployees } from '@/mocks/data/employees';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { confirmPasswordForTests, signInForTests } from '@/test/session';
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

  it('keeps the Ghana Card number read-only, and says why', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(ACTIVE?.id ?? '');

    const card = await screen.findByLabelText<HTMLInputElement>('Ghana Card number');
    expect(card).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Started on')).not.toHaveAttribute('readonly');
    // And the page says why, rather than leaving somebody guessing.
    expect(screen.getByText(/identifies this person for life/)).toBeInTheDocument();
    expect(screen.getByText(/start date asks for your password/)).toBeInTheDocument();
  });

  it('corrects the start date through its own password-protected route', async () => {
    await signInForTests('hr@samtec.example');
    await confirmPasswordForTests();
    const user = userEvent.setup();
    const sent: string[] = [];
    const seeRequest = ({ request }: { request: Request }) => {
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
    };
    server.events.on('request:start', seeRequest);
    try {
      renderPage(ACTIVE?.id ?? '');
      const started = await screen.findByLabelText('Started on');
      await user.clear(started);
      await user.type(started, '2020-01-15');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText('Their record')).toBeInTheDocument();
      expect(sent).toContain(`PUT /api/v1/employees/${ACTIVE?.id}/start-date`);
      // Nothing else changed, so no ordinary edit was sent.
      expect(sent).not.toContain(`PATCH /api/v1/employees/${ACTIVE?.id}`);
    } finally {
      server.events.removeListener('request:start', seeRequest);
    }
  });

  it('refuses to open a form for somebody who has left', async () => {
    await signInForTests('hr@samtec.example');
    renderPage(LEFT?.id ?? '');

    expect(await screen.findByText('This record cannot be changed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Position')).not.toBeInTheDocument();
  });
});
