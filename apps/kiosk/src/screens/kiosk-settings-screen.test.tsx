import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KioskSettingsScreen } from './kiosk-settings-screen';

/**
 * A placeholder today (issue #99 task 2 fills it in). All that matters yet is
 * that it is reachable and has a way back to the admin menu.
 */
describe('KioskSettingsScreen', () => {
  it('says what is coming, and leads back to the admin menu', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={onBack} />);

    expect(screen.getByRole('heading', { name: 'Kiosk settings' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
