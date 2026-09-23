import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { EmployeeDetailPage } from './employee-detail-page';

const KWAME = '01927c3e-5a4b-7c8d-9e0f-000000000001'; // SMT-00001, posted at ACC-01
const AKUA = '01927c3e-5a4b-7c8d-9e0f-000000000004'; // SMT-00004, posted at ACC-02
const NOBODY = '01927c3e-5a4b-7c8d-9e0f-000000000999';

function renderDetailPage(employeeId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/employees/:employeeId" element={<EmployeeDetailPage />} />
      <Route path={routes.employees} element={<p>Employee list</p>} />
    </Routes>,
    { route: routes.employee(employeeId) },
  );
}

describe('EmployeeDetailPage', () => {
  it('shows the full record, including the Ghana Card number, to an administrator', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage(KWAME);

    expect(await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' })).toBeInTheDocument();
    // Staff number and position share one line under the name.
    expect(screen.getByText('SMT-00001 · Security Guard')).toBeInTheDocument();
    expect(screen.getByText('KM')).toBeInTheDocument();
    expect(screen.getByText('Ridge Towers Office Complex')).toBeInTheDocument();
    expect(screen.getByText('11 Mar 2024')).toBeInTheDocument();
    // A timestamp is shown in Ghana time, whatever zone the computer is in.
    expect(screen.getByText('12 Mar 2024, 10:00')).toBeInTheDocument();
    expect(screen.getByText('Ghana Card')).toBeInTheDocument();
    expect(screen.getByText('GHA-000000001-1')).toBeInTheDocument();
  });

  it('shows the leaving date and "Not posted" for someone who has left', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000009'); // Kojo Frimpong, terminated

    expect(await screen.findByRole('heading', { name: 'Kojo Frimpong' })).toBeInTheDocument();
    expect(screen.getByText('Left')).toBeInTheDocument();
    expect(screen.getByText('31 Jul 2026')).toBeInTheDocument();
    expect(screen.getByText('Not posted')).toBeInTheDocument();
  });

  it('shows "Not enrolled" for a new starter without biometrics', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000002'); // Abena Owusu, pending enrolment

    expect(await screen.findByRole('heading', { name: 'Abena Owusu' })).toBeInTheDocument();
    expect(screen.getByText('Not enrolled')).toBeInTheDocument();
    expect(screen.queryByText('Left')).not.toBeInTheDocument();
  });

  it('replaces the record with the error when a later reload is refused', async () => {
    await signInForTests('supervisor@samtec.example');
    const { queryClient } = renderDetailPage(KWAME);
    await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });

    // The guard was moved out of this supervisor's site: the API now answers 404.
    server.use(
      http.get(
        `${env.apiBaseUrl}/employees/:employeeId`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Not Found',
              status: 404,
              detail: 'No employee exists with this ID.',
              traceId: 'trace-test-moved',
            },
            { status: 404 },
          ),
        { once: true },
      ),
    );
    await queryClient.refetchQueries();

    expect(await screen.findByText('No employee found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Kwame Kofi Mensah' })).not.toBeInTheDocument();
    expect(screen.queryByText('+233200000001')).not.toBeInTheDocument();
  });

  it('leaves the Ghana Card row out when the API does not send it', async () => {
    await signInForTests('supervisor@samtec.example');

    renderDetailPage(KWAME);

    expect(await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' })).toBeInTheDocument();
    expect(screen.queryByText('Ghana Card')).not.toBeInTheDocument();
    expect(screen.queryByText(/^GHA-/)).not.toBeInTheDocument();
  });

  it('lets a guard see their own record, Ghana Card included', async () => {
    await signInForTests('guard@samtec.example');

    renderDetailPage(KWAME);

    expect(await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' })).toBeInTheDocument();
    expect(screen.getByText('GHA-000000001-1')).toBeInTheDocument();
    // A guard may not open the list, so the page offers no link to it.
    expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
  });

  it('says nothing was found for a record this role may not see', async () => {
    await signInForTests('supervisor@samtec.example');

    renderDetailPage(AKUA);

    expect(await screen.findByText('No employee found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('says nothing was found for an unknown ID', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage(NOBODY);

    expect(await screen.findByText('No employee found')).toBeInTheDocument();
  });

  it('explains a server error with a trace ID and a way to try again', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(
        `${env.apiBaseUrl}/employees/:employeeId`,
        () =>
          HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              detail: 'The database is not available.',
              traceId: 'trace-test-detail',
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );

    renderDetailPage(KWAME);

    expect(await screen.findByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByText('Trace ID: trace-test-detail')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' })).toBeInTheDocument();
  });

  it('offers no retry for an ID that is not valid, since it would fail the same way', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage('not-an-id');

    expect(await screen.findByText('Must be a valid ID.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows an administrator the Biometrics panel with consent, face and keys', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage(KWAME);

    expect(await screen.findByText('Consent')).toBeInTheDocument();
    expect(await screen.findByText('In use')).toBeInTheDocument();
    expect(screen.getByText(/^Given/)).toBeInTheDocument();
    expect(screen.getByText('Looks like nobody else')).toBeInTheDocument();
    // Kwame saved a finger on the ACC-01 kiosk.
    expect(screen.getByText(/· in use/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wipe the face and keys' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Record a withdrawal of consent' }),
    ).toBeInTheDocument();
  });

  it('lets a second administrator approve an exemption another one asked for', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000010'); // Selorm Agbeko, declined biometrics
    await screen.findByRole('heading', { name: 'Selorm Agbeko' });

    expect(await screen.findByText('Waiting for a second administrator')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Decide the exemption' }));
    await user.click(screen.getByRole('radio', { name: /Approve/ }));
    await user.type(screen.getByLabelText('Note'), 'Ghana Card checked in person; approved.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide the exemption' })).not.toBeInTheDocument();
  });

  it('wipes a face with a reason', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage(KWAME);
    await screen.findByText('In use');

    await user.click(screen.getByRole('button', { name: 'Wipe the face and keys' }));
    await user.type(screen.getByLabelText('Reason'), 'Enrolled against the wrong record.');
    await user.click(screen.getByRole('button', { name: 'Confirm the wipe' }));

    expect(await screen.findByText('Wiped')).toBeInTheDocument();
    expect(screen.getByText(/switched off/)).toBeInTheDocument();
    expect(screen.queryByText(/· in use/)).not.toBeInTheDocument();
  });

  it('records a withdrawal of consent, which wipes the face and files an exemption request', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage(KWAME);
    await screen.findByText('In use');

    await user.click(screen.getByRole('button', { name: 'Record a withdrawal of consent' }));
    await user.type(screen.getByLabelText('Reason'), 'Withdrew consent in writing today.');
    await user.click(screen.getByRole('button', { name: 'Record the withdrawal' }));

    expect(await screen.findByText(/^Withdrawn/)).toBeInTheDocument();
    expect(screen.getByText('Wiped')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a second administrator')).toBeInTheDocument();
    // The recording administrator asked for the exemption, so they may not decide it.
    expect(screen.getByText(/You asked for this exemption/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide the exemption' })).not.toBeInTheDocument();
  });

  it('lets an administrator ask for an exemption, then leaves the decision to another', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000010'); // Selorm Agbeko, request waiting
    await screen.findByText('Waiting for a second administrator');

    // Reject the request another administrator made; Selorm is then free to be asked for again.
    await user.click(screen.getByRole('button', { name: 'Decide the exemption' }));
    await user.click(screen.getByRole('radio', { name: /Reject/ }));
    await user.type(screen.getByLabelText('Note'), 'The worker will try the kiosk once more.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));
    expect(await screen.findByText('Rejected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ask for an exemption' }));
    await user.selectOptions(screen.getByLabelText('Reason'), 'CANNOT_ENROLL');
    await user.type(screen.getByLabelText('Note'), 'The kiosk cannot read the face; three tries.');
    await user.click(screen.getByRole('button', { name: 'Send the request' }));

    expect(await screen.findByText('Waiting for a second administrator')).toBeInTheDocument();
    expect(screen.getByText('The kiosk cannot read their face')).toBeInTheDocument();
    expect(screen.getByText(/You asked for this exemption/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide the exemption' })).not.toBeInTheDocument();
  });

  it('offers no wipe while a duplicate review is open', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000002'); // Abena Owusu, face under review

    expect(await screen.findByText('Waiting for a second administrator')).toBeInTheDocument();
    expect(screen.getByText('Looks like someone already enrolled')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Wipe the face and keys' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask for an exemption' })).not.toBeInTheDocument();
  });

  it('shows a supervisor the panel without any action', async () => {
    await signInForTests('supervisor@samtec.example');

    renderDetailPage(KWAME);

    expect(await screen.findByText('In use')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Wipe the face and keys' }),
    ).not.toBeInTheDocument();
  });

  it('shows a guard no Biometrics panel at all', async () => {
    await signInForTests('guard@samtec.example');

    renderDetailPage(KWAME);

    expect(await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' })).toBeInTheDocument();
    // The panel's own rows never appear (the API would refuse a guard anyway).
    expect(screen.queryByText('Consent')).not.toBeInTheDocument();
    expect(screen.queryByText('Fingerprint keys')).not.toBeInTheDocument();
  });

  it('links back to the employee list', async () => {
    await signInForTests('admin@samtec.example');
    renderDetailPage(KWAME);
    await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });

    await userEvent.setup().click(screen.getByRole('link', { name: 'Employees' }));

    expect(await screen.findByText('Employee list')).toBeInTheDocument();
  });
});
