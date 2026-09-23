import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describeDrift, driftIsSuspect } from '@/lib/attendance';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DevicesPage } from './devices-page';

describe('DevicesPage', () => {
  it('lists every device with its health, flagging a clock that runs fast', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<DevicesPage />);

    expect(await screen.findByRole('link', { name: 'Mock terminal TEM-01' })).toBeInTheDocument();
    expect(screen.getByText('7 min fast · suspect')).toBeInTheDocument();
    expect(screen.getByText('Face kiosk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register device' })).toBeInTheDocument();
  });
});

describe('describeDrift', () => {
  it('describes a clock in plain words', () => {
    expect(describeDrift(null)).toBe('—');
    expect(describeDrift(0)).toBe('exact');
    expect(describeDrift(2)).toBe('2 s fast');
    expect(describeDrift(-45)).toBe('45 s slow');
    expect(describeDrift(420)).toBe('7 min fast');
  });

  it('flags only a clock more than 5 minutes off', () => {
    expect(driftIsSuspect(null)).toBe(false);
    expect(driftIsSuspect(300)).toBe(false);
    expect(driftIsSuspect(301)).toBe(true);
    expect(driftIsSuspect(-420)).toBe(true);
  });
});
