import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { ExceptionDetailPage } from './exception-detail-page';

// The mock queue's fixed IDs (src/mocks/data/attendance.ts).
const MISSING_CLOCK_OUT = '01927c3e-6666-7eee-8fff-000000000001';
const UNKNOWN_EMPLOYEE = '01927c3e-6666-7eee-8fff-000000000003';
const OVERLAP = '01927c3e-6666-7eee-8fff-000000000005';
const NOBODY = '01927c3e-6666-7eee-8fff-000000000999';

function renderExceptionPage(exceptionId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/attendance/exceptions/:exceptionId" element={<ExceptionDetailPage />} />
      <Route path={routes.exceptions} element={<p>The queue</p>} />
    </Routes>,
    { route: routes.exception(exceptionId) },
  );
}

describe('ExceptionDetailPage', () => {
  it('lets an administrator dismiss an unknown device user with a note', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderExceptionPage(UNKNOWN_EMPLOYEE);
    await screen.findByRole('heading', { name: 'Unknown device user' });

    // The evidence names the device and the number nobody matches.
    expect(screen.getByText('99001')).toBeInTheDocument();
    // Only dismissing is offered for an unknown number.
    expect(screen.getByRole('radio', { name: /Dismiss/ })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /Add the shift/ })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Note'), 'A visiting technician tested the reader.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('A visiting technician tested the reader.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record the decision' })).not.toBeInTheDocument();
  });

  it('adds a shift by hand around a missing clock-out, and the shift appears in attendance', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderExceptionPage(MISSING_CLOCK_OUT);
    await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });

    await user.click(screen.getByRole('radio', { name: /Add the shift by hand/ }));
    // The start is prefilled with the real clock-in; the end suggests a day shift.
    const start = screen.getByLabelText<HTMLInputElement>('Shift started (Ghana time)');
    const end = screen.getByLabelText<HTMLInputElement>('Shift ended (Ghana time)');
    expect(start.value).toMatch(/T05:58$/);
    expect(end.value).toMatch(/T17:58$/);
    await user.type(screen.getByLabelText('Note'), 'The relief guard confirms the 18:00 handover.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Add the shift by hand')).toBeInTheDocument();

    // The mock API now holds a MANUAL shift on that day for Kwame.
    const from = start.value.slice(0, 10);
    const shifts = await fetchClient.GET('/attendance/segments', {
      params: { query: { from, to: from, employeeId: '01927c3e-5a4b-7c8d-9e0f-000000000001' } },
    });
    expect(shifts.data?.items.some((segment) => segment.basis === 'MANUAL')).toBe(true);
  });

  it('refuses hours added by hand that leave out the real punch', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderExceptionPage(MISSING_CLOCK_OUT);
    await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });

    await user.click(screen.getByRole('radio', { name: /Add the shift by hand/ }));
    const start = screen.getByLabelText<HTMLInputElement>('Shift started (Ghana time)');
    // Move the start to after the real 05:58 clock-in.
    fireEvent.change(start, { target: { value: start.value.replace(/T05:58$/, 'T07:00') } });
    await user.type(screen.getByLabelText('Note'), 'A guess at the hours, nothing confirmed.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(
      await screen.findByText("The hours must include the real punch's time."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Resolved')).not.toBeInTheDocument();
  });

  it('keeps one of two overlapping shifts', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderExceptionPage(OVERLAP);
    await screen.findByRole('heading', { name: 'Ibrahim Iddrisu' });

    expect(screen.getByRole('radio', { name: /Keep one shift/ })).toBeChecked();
    const shifts = screen.getAllByRole('radio', { name: /–/ });
    expect(shifts).toHaveLength(2);
    await user.click(shifts[1] as HTMLElement);
    await user.type(
      screen.getByLabelText('Note'),
      'He was at Kumasi all day; the Takoradi punch is a stray.',
    );
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Keep one shift and void the other')).toBeInTheDocument();
  });

  it('shows HR the evidence but no decision form', async () => {
    await signInForTests('hr@samtec.example');
    renderExceptionPage(MISSING_CLOCK_OUT);
    await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });

    expect(screen.getByText(/HR reads the queue but never creates hours/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record the decision' })).not.toBeInTheDocument();
  });

  it('asks for a note before recording anything', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderExceptionPage(UNKNOWN_EMPLOYEE);
    await screen.findByRole('heading', { name: 'Unknown device user' });

    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(
      await screen.findByText('Explain the decision in 3 to 500 characters.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('says calmly when there is no such exception', async () => {
    await signInForTests('admin@samtec.example');
    renderExceptionPage(NOBODY);

    expect(await screen.findByText('No exception found')).toBeInTheDocument();
  });
});
