import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { env } from '@/lib/env';
import { MOCK_PASSWORD } from '@/mocks/data/users';
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

  it("links the current site's name to the site's own page", async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage(KWAME);

    const siteLink = await screen.findByRole('link', { name: 'Ridge Towers Office Complex' });
    expect(siteLink).toHaveAttribute('href', routes.site('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01'));
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

  it('lets an administrator approve an exemption another one asked for', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000010'); // Selorm Agbeko, declined biometrics
    await screen.findByRole('heading', { name: 'Selorm Agbeko' });

    expect(await screen.findByText('Waiting for a decision')).toBeInTheDocument();
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

  it('records a withdrawal of consent, which wipes the face and files nothing else', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage(KWAME);
    await screen.findByText('In use');

    await user.click(screen.getByRole('button', { name: 'Record a withdrawal of consent' }));
    await user.type(screen.getByLabelText('Reason'), 'Withdrew consent in writing today.');
    await user.click(screen.getByRole('button', { name: 'Record the withdrawal' }));

    expect(await screen.findByText(/^Withdrawn/)).toBeInTheDocument();
    expect(screen.getByText('Wiped')).toBeInTheDocument();
    // No exemption request is filed on the worker's behalf any more: asking
    // for one is a separate, deliberate step.
    expect(screen.queryByText('Waiting for a decision')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide the exemption' })).not.toBeInTheDocument();
  });
  it('lets an administrator ask for an exemption and decide it themselves', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000010'); // Selorm Agbeko, request waiting
    await screen.findByText('Waiting for a decision');

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

    expect(await screen.findByText('Waiting for a decision')).toBeInTheDocument();
    expect(screen.getByText('The kiosk cannot read their face')).toBeInTheDocument();

    // The same administrator decides it: no second person is needed.
    await user.click(screen.getByRole('button', { name: 'Decide the exemption' }));
    await user.click(screen.getByRole('radio', { name: /Approve/ }));
    await user.type(screen.getByLabelText('Note'), 'Ghana Card checked in person; approved.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
  });
  it('offers no wipe while a duplicate review is open', async () => {
    await signInForTests('admin@samtec.example');

    renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000002'); // Abena Owusu, face under review

    expect(await screen.findByText('Waiting for review on the dashboard')).toBeInTheDocument();
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

  it('never shows the registered-worker notice on an ordinary visit', async () => {
    await signInForTests('admin@samtec.example');
    renderDetailPage(KWAME);

    await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });
    expect(screen.queryByText(/Worker registered/)).not.toBeInTheDocument();
  });

  describe('the Pay card', () => {
    it('shows an administrator pay terms and payment details already on file', async () => {
      await signInForTests('admin@samtec.example');
      renderDetailPage(KWAME);

      expect(await screen.findByText('Pay')).toBeInTheDocument();
      expect(screen.getByText('Pay terms')).toBeInTheDocument();
      expect(screen.getByText('Payment details')).toBeInTheDocument();
      // Kwame already has pay terms and a bank account on file (src/mocks/data/payroll.ts).
      expect(await screen.findByText('Akwaaba Bank')).toBeInTheDocument();
      expect(screen.queryByText(/No pay terms yet/)).not.toBeInTheDocument();
    });

    it('shows a supervisor no Pay card at all', async () => {
      await signInForTests('supervisor@samtec.example');
      renderDetailPage(KWAME);

      await screen.findByRole('heading', { name: 'Kwame Kofi Mensah' });
      expect(screen.queryByText('Pay')).not.toBeInTheDocument();
      expect(screen.queryByText('Pay terms')).not.toBeInTheDocument();
      expect(screen.queryByText('Payment details')).not.toBeInTheDocument();
    });

    it('shows a calm notice when a worker has no pay terms yet', async () => {
      await signInForTests('admin@samtec.example');
      renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000010'); // Selorm Agbeko, SMT-00010

      expect(
        await screen.findByText(
          'No pay terms yet. Add them, or this worker is left out of every payroll run.',
        ),
      ).toBeInTheDocument();
    });

    it('shows "Not on file" for a worker nobody has entered payment details for', async () => {
      await signInForTests('admin@samtec.example');
      // Afua Darko, SMT-00011: beyond the first ten employees, so the mock has
      // never stored a payment details row for her at all (src/mocks/data/payroll.ts).
      renderDetailPage('01927c3e-5a4b-7c8d-9e0f-000000000011');

      await screen.findByText('Payment details');
      expect(await screen.findAllByText('Not on file')).toHaveLength(4);
    });

    it('saves pay terms to the pesewa, converting from the cedis typed into the form', async () => {
      await signInForTests('admin@samtec.example');
      const user = userEvent.setup();
      renderDetailPage(KWAME);

      await user.click(await screen.findByRole('button', { name: 'Edit pay terms' }));
      const basicPay = screen.getByLabelText('Basic monthly pay (GH₵)');
      await user.clear(basicPay);
      await user.type(basicPay, '1234.56');
      await user.click(screen.getByRole('button', { name: 'Save pay terms' }));

      // 1,234.56 cedis is exactly 123456 pesewas. formatCedis only ever shows
      // this for that exact integer, so reading it back proves the amount sent
      // was 123456, not a float one rounding error away from it.
      expect(await screen.findByText('GH₵ 1,234.56')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save pay terms' })).not.toBeInTheDocument();
    });

    it('rejects an amount with more than two decimal places before sending it', async () => {
      await signInForTests('admin@samtec.example');
      const user = userEvent.setup();
      renderDetailPage(KWAME);

      await user.click(await screen.findByRole('button', { name: 'Edit pay terms' }));
      const basicPay = screen.getByLabelText('Basic monthly pay (GH₵)');
      await user.clear(basicPay);
      await user.type(basicPay, '12.999');
      await user.click(screen.getByRole('button', { name: 'Save pay terms' }));

      expect(await screen.findByText(/at most two decimal places/)).toBeInTheDocument();
      // Still on the form: nothing was sent.
      expect(screen.getByRole('button', { name: 'Save pay terms' })).toBeInTheDocument();
    });

    it('asks for the administrator password before saving new payment details', async () => {
      await signInForTests('admin@samtec.example', { confirmPassword: false });
      const user = userEvent.setup();
      renderDetailPage(KWAME);

      await user.click(await screen.findByRole('button', { name: 'Edit payment details' }));
      const accountNumber = screen.getByLabelText('Account number');
      await user.clear(accountNumber);
      await user.type(accountNumber, '55501234567');
      await user.click(screen.getByRole('button', { name: 'Save payment details' }));

      const dialog = await screen.findByRole('alertdialog', { name: 'Confirm with your password' });
      await user.type(within(dialog).getByLabelText('Password'), MOCK_PASSWORD);
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });
      expect(await screen.findByText('55501234567')).toBeInTheDocument();
    });
  });
});
