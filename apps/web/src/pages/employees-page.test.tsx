import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { EmployeesPage } from './employees-page';

describe('EmployeesPage', () => {
  // The employee list needs a signed-in user, like the real API.
  beforeEach(() => signInForTests());

  it('lists employees from the API', async () => {
    renderWithProviders(<EmployeesPage />);

    expect(await screen.findByText('Kwame Kofi Mensah')).toBeInTheDocument();
    expect(screen.getByText('SMT-00001')).toBeInTheDocument();
  });

  it('moves to the next page and back', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);
    await screen.findByText('SMT-00001');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('SMT-00011')).toBeInTheDocument();
    expect(screen.queryByText('SMT-00001')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('SMT-00001')).toBeInTheDocument();
    expect(screen.queryByText('SMT-00011')).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);
    await screen.findByText('Kwame Kofi Mensah');

    await user.selectOptions(screen.getByLabelText('Status'), 'SUSPENDED');

    expect(await screen.findByText('Grace Adjei')).toBeInTheDocument();
    expect(screen.queryByText('Kwame Kofi Mensah')).not.toBeInTheDocument();
  });

  it('shows a message when no employee matches the search', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);
    await screen.findByText('Kwame Kofi Mensah');

    await user.type(screen.getByLabelText('Search employees'), 'Nobody-By-This-Name');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('No employees match these filters.')).toBeInTheDocument();
  });

  it('asks for a longer search instead of sending one character', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);
    await screen.findByText('Kwame Kofi Mensah');

    await user.type(screen.getByLabelText('Search employees'), 'K');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(screen.getByLabelText('Search employees')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Kwame Kofi Mensah')).toBeInTheDocument();
  });

  it('explains the problem when the API fails', async () => {
    server.use(
      http.get(`${env.apiBaseUrl}/employees`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'The database is not available.',
            traceId: 'trace-test-1',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<EmployeesPage />);

    expect(await screen.findByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByText('Trace ID: trace-test-1')).toBeInTheDocument();
  });
});
