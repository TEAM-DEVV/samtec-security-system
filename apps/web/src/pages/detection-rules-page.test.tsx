import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DetectionRulesPage } from './detection-rules-page';

describe('DetectionRulesPage', () => {
  it('lists all eleven rules for an administrator, with their numbers', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<DetectionRulesPage />);

    expect(await screen.findAllByRole('region')).toHaveLength(11);
    const neverSeen = screen.getByRole('region', { name: /^R5 ·/ });
    expect(within(neverSeen).getByLabelText('Window (days)')).toHaveValue(14);
    // A rule with no numbers says so, rather than showing an empty form.
    const duplicate = screen.getByRole('region', { name: /^R1 ·/ });
    expect(within(duplicate).getByText(/a fact, not a gradient/)).toBeInTheDocument();
  });

  it('lets an administrator switch a rule off, and move a number', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DetectionRulesPage />);
    const neverSeen = await screen.findByRole('region', { name: /^R5 ·/ });

    await user.click(within(neverSeen).getByRole('button', { name: 'Switch off R5' }));
    expect(
      await within(neverSeen).findByRole('button', { name: 'Switch on R5' }),
    ).toBeInTheDocument();
    expect(within(neverSeen).getByText(/Skipped by every run/)).toBeInTheDocument();

    const days = within(neverSeen).getByLabelText('Window (days)');
    await user.clear(days);
    await user.type(days, '30');
    await user.click(within(neverSeen).getByRole('button', { name: 'Save R5' }));

    expect(await within(neverSeen).findByRole('status')).toHaveTextContent('Saved.');
    expect(within(neverSeen).getByLabelText('Window (days)')).toHaveValue(30);
  });

  it('refuses half a day: thresholds are whole numbers', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DetectionRulesPage />);
    const neverSeen = await screen.findByRole('region', { name: /^R5 ·/ });

    const days = within(neverSeen).getByLabelText('Window (days)');
    await user.clear(days);
    await user.type(days, '14.5');
    await user.click(within(neverSeen).getByRole('button', { name: 'Save R5' }));

    expect(
      await within(neverSeen).findByText('Window (days) must be a whole number, zero or more.'),
    ).toBeInTheDocument();
    expect(within(neverSeen).queryByRole('status')).not.toBeInTheDocument();
  });

  it('refuses a number that is not a number', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DetectionRulesPage />);
    const neverSeen = await screen.findByRole('region', { name: /^R5 ·/ });

    await user.clear(within(neverSeen).getByLabelText('Window (days)'));
    await user.click(within(neverSeen).getByRole('button', { name: 'Save R5' }));

    expect(
      await within(neverSeen).findByText('Window (days) must be a whole number, zero or more.'),
    ).toBeInTheDocument();
  });

  it('shows HR the rules but no way to change them', async () => {
    await signInForTests('hr@samtec.example');

    renderWithProviders(<DetectionRulesPage />);

    expect(await screen.findAllByRole('region')).toHaveLength(11);
    expect(screen.queryByRole('button', { name: /Switch/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only an administrator changes them/)).toBeInTheDocument();
  });
});
