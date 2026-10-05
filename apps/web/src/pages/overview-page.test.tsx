import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { OverviewPage } from './overview-page';

describe('OverviewPage', () => {
  it('greets the signed-in person by first name and offers the pages their role may open', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByRole('heading', { name: /, Yaw$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Employees/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sites/ })).toBeInTheDocument();
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
  });

  it('offers a guard no pages they may not open', async () => {
    await signInForTests('guard@samtec.example');

    renderWithProviders(<OverviewPage />);

    await screen.findByRole('heading', { name: /, Kwame$/ });
    expect(screen.queryByRole('link', { name: /Employees/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Sites/ })).not.toBeInTheDocument();
    expect(screen.getByText('Guard')).toBeInTheDocument();
  });
});
