import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DetectionAlertPage } from './detection-alert-page';

// The mock queue's fixed IDs (src/mocks/data/detection.ts).
const NEVER_SEEN = '01927c3e-5100-7000-8000-000000000001';
const DUPLICATE_FACE = '01927c3e-5100-7000-8000-000000000002';
const DEVICE_SPIKE = '01927c3e-5100-7000-8000-000000000005';
const NOBODY = '01927c3e-5100-7000-8000-000000000999';

function renderAlertPage(alertId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/detection/alerts/:alertId" element={<DetectionAlertPage />} />
      <Route path={routes.detection} element={<p>The queue</p>} />
    </Routes>,
    { route: routes.detectionAlert(alertId) },
  );
}

describe('DetectionAlertPage', () => {
  it('shows the question, the evidence in plain words, and lets an administrator answer it', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderAlertPage(NEVER_SEEN);
    await screen.findByRole('heading', { name: 'Selorm Agbeko' });

    expect(screen.getByText('Has this worker ever come to work?')).toBeInTheDocument();
    // Evidence keys become words a person reads; the numbers stay exact.
    expect(screen.getByText('Days on the books')).toBeInTheDocument();
    expect(screen.getByText('29')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Resolved/ })).toBeChecked();

    await user.type(screen.getByLabelText('Note'), 'HR entered the hire date a month early.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(await screen.findByText('HR entered the hire date a month early.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record the decision' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Resolved').length).toBeGreaterThan(0);
  });

  it('lets HR confirm fraud, with a note', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();
    renderAlertPage(DUPLICATE_FACE);
    await screen.findByRole('heading', { name: 'Emmanuel Tetteh' });

    // What the face looked like is named by staff number, never by a template.
    expect(screen.getByText('Looked like')).toBeInTheDocument();
    expect(screen.getByText('SMT-00006')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Confirmed fraud/ }));
    await user.type(screen.getByLabelText('Note'), 'Same person as SMT-00006; both cards seen.');
    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(
      await screen.findByText('Same person as SMT-00006; both cards seen.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed fraud').length).toBeGreaterThan(0);
  });

  it('refuses a decision without a note', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderAlertPage(NEVER_SEEN);
    await screen.findByRole('heading', { name: 'Selorm Agbeko' });

    await user.click(screen.getByRole('button', { name: 'Record the decision' }));

    expect(
      await screen.findByText('Explain the decision in 3 to 500 characters.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record the decision' })).toBeInTheDocument();
  });

  it('shows a decided alert with its note, and no form', async () => {
    await signInForTests('admin@samtec.example');
    renderAlertPage(DEVICE_SPIKE);
    await screen.findByRole('heading', { name: 'ACC-01 Main Gate' });

    expect(screen.getByText(/Client event day/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record the decision' })).not.toBeInTheDocument();
  });

  it('says plainly when there is no such alert', async () => {
    await signInForTests('admin@samtec.example');
    renderAlertPage(NOBODY);

    expect(await screen.findByText('No alert found')).toBeInTheDocument();
  });
});
