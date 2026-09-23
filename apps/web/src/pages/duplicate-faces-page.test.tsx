import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { env } from '@/lib/env';
import { mockCollisions } from '@/mocks/data/biometrics';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DuplicateFacesPage } from './duplicate-faces-page';

/** Abena Owusu, the new starter whose face looked like Grace Adjei's (src/mocks/data/biometrics.ts). */
const ABENA = '01927c3e-5a4b-7c8d-9e0f-000000000002';
const GRACE = '01927c3e-5a4b-7c8d-9e0f-000000000006';
/** admin@samtec.example (src/mocks/data/users.ts). */
const MOCK_ADMIN_ID = '01927c3e-2222-7ccc-9ddd-000000000001';

describe('DuplicateFacesPage', () => {
  it('shows an administrator the open case with both people and the score', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<DuplicateFacesPage />);

    expect(await screen.findByRole('link', { name: 'Abena Owusu' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grace Adjei' })).toBeInTheDocument();
    expect(screen.getByText(/71% alike/)).toBeInTheDocument();
    // "Open" is both the status filter's choice and the card's badge.
    expect(screen.getAllByText('Open')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Record the decision' })).toBeInTheDocument();
  });

  it('asks for a note, and for SAME_PERSON which record to keep', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DuplicateFacesPage />);
    await screen.findByRole('link', { name: 'Abena Owusu' });

    await user.click(screen.getByRole('button', { name: 'Record the decision' }));
    expect(await screen.findByText(/Explain the decision in 3 to 500/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /One person with two records/ }));
    await user.type(screen.getByLabelText('Note'), 'Both cards checked: the same person.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));
    expect(
      await screen.findByText(/Choose the record that belongs to the person/),
    ).toBeInTheDocument();
  });

  it('blocks the duplicate record once one person is found to have two', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DuplicateFacesPage />);
    await screen.findByRole('link', { name: 'Abena Owusu' });

    await user.click(screen.getByRole('radio', { name: /One person with two records/ }));
    await user.click(screen.getByRole('radio', { name: /Grace Adjei/ }));
    await user.type(screen.getByLabelText('Note'), 'Both cards checked: the same person.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    // The case leaves the open queue.
    expect(await screen.findByText('Nothing waits for a decision.')).toBeInTheDocument();

    // Grace's record was kept; Abena's is blocked for good.
    const abena = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: ABENA } },
    });
    expect(abena.data?.face.status).toBe('BLOCKED');
    const grace = await fetchClient.GET('/employees/{employeeId}/biometrics', {
      params: { path: { employeeId: GRACE } },
    });
    expect(grace.data?.face.status).toBe('ACTIVE');
  });

  it('gives the administrator who enrolled the face no decision form', async () => {
    await signInForTests('admin@samtec.example');
    // The same open case, but enrolled by the signed-in administrator.
    server.use(
      http.get(`${env.apiBaseUrl}/biometric-collisions`, () => {
        const items = mockCollisions
          .filter((collision) => collision.status === 'OPEN')
          .map((collision) => ({ ...collision, enrolledByUserId: MOCK_ADMIN_ID }));
        return HttpResponse.json({ items, nextCursor: null });
      }),
    );

    renderWithProviders(<DuplicateFacesPage />);

    expect(await screen.findByText(/You enrolled this face/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record the decision' })).not.toBeInTheDocument();
  });

  it('lists decided cases with their verdict', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DuplicateFacesPage />);
    await screen.findByRole('link', { name: 'Abena Owusu' });

    await user.selectOptions(screen.getByLabelText('Status'), 'RESOLVED');

    expect(await screen.findByText('Two different people who look alike')).toBeInTheDocument();
    expect(screen.getByText('Brothers; both Ghana Cards checked in person.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record the decision' })).not.toBeInTheDocument();
  });
});
