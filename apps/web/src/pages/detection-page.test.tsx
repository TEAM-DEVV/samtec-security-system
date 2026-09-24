import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DetectionPage } from './detection-page';

// The rule filter lists every rule's name too, so the checks below look at table cells.
describe('DetectionPage', () => {
  it('shows an administrator every open alert, and who is at most risk', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<DetectionPage />);

    // Three OPEN in the mock queue; the UNDER_REVIEW and RESOLVED ones wait behind the filter.
    expect(await screen.findAllByRole('link', { name: 'Open' })).toHaveLength(3);
    expect(screen.getByRole('cell', { name: /Selorm Agbeko/ })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /Emmanuel Tetteh/ })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /Ibrahim Iddrisu/ })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: /ACC-01 Main Gate/ })).not.toBeInTheDocument();

    // The CRITICAL duplicate enrollment outscores everybody.
    const risk = screen.getByRole('region', { name: 'Highest risk' });
    const first = within(risk).getAllByRole('listitem')[0];
    expect(first).toHaveTextContent('Emmanuel Tetteh');
    expect(first).toHaveTextContent('score 10');
  });

  it('filters by status, rule and severity', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DetectionPage />);
    await screen.findAllByRole('link', { name: 'Open' });

    await user.selectOptions(screen.getByLabelText('Status'), 'RESOLVED');
    expect(await screen.findByRole('cell', { name: /ACC-01 Main Gate/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText('Status'), 'OPEN');
    await user.selectOptions(screen.getByLabelText('Severity'), 'CRITICAL');
    expect(await screen.findByRole('cell', { name: /Emmanuel Tetteh/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText('Severity'), '');
    await user.selectOptions(screen.getByLabelText('Rule'), 'R5');
    expect(await screen.findByRole('cell', { name: /Selorm Agbeko/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1);
  });

  it('lets an administrator run the rules now, and says what happened', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<DetectionPage />);
    await screen.findAllByRole('link', { name: 'Open' });

    await user.click(screen.getByRole('button', { name: 'Run the rules now' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Ran 11 rules. No new alerts.');
  });

  it('shows HR the queue but never the button that runs the rules', async () => {
    await signInForTests('hr@samtec.example');

    renderWithProviders(<DetectionPage />);

    expect(await screen.findAllByRole('link', { name: 'Open' })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Run the rules now' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rules' })).toBeInTheDocument();
  });
});
