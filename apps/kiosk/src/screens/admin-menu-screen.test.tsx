import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminSession } from '@/lib/admin-session';
import { AdminMenuScreen } from './admin-menu-screen';

/**
 * What an administrator sees right after signing in.
 *
 * Nothing here talks to the server — it is four buttons and a heading — so
 * these tests are only about the one thing that matters: each item reaches
 * the handler the app gave it, and none of them is confused for another.
 */
const ADMIN: AdminSession = {
  accessToken: 'test-admin-token',
  fullName: 'Ama Boateng',
  expiresAt: Date.now() + 900_000,
};

function renderMenu() {
  const handlers = {
    onEnroll: vi.fn(),
    onFingerprint: vi.fn(),
    onSettings: vi.fn(),
    onBackToClockIn: vi.fn(),
  };
  render(<AdminMenuScreen admin={ADMIN} {...handlers} />);
  return handlers;
}

describe('AdminMenuScreen', () => {
  it('offers every admin task as its own plain item', () => {
    renderMenu();

    expect(screen.getByRole('heading', { name: 'Admin menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enroll a worker’s face' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save a fingerprint' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kiosk settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to clock-in' })).toBeInTheDocument();
  });

  it('opens enrolling on the face task', async () => {
    const user = userEvent.setup();
    const handlers = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Enroll a worker’s face' }));

    expect(handlers.onEnroll).toHaveBeenCalledTimes(1);
    expect(handlers.onFingerprint).not.toHaveBeenCalled();
  });

  it('opens enrolling on the fingerprint task, not the face one', async () => {
    const user = userEvent.setup();
    const handlers = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Save a fingerprint' }));

    expect(handlers.onFingerprint).toHaveBeenCalledTimes(1);
    expect(handlers.onEnroll).not.toHaveBeenCalled();
  });

  it('opens kiosk settings', async () => {
    const user = userEvent.setup();
    const handlers = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Kiosk settings' }));

    expect(handlers.onSettings).toHaveBeenCalledTimes(1);
  });

  it('is the only item that signs the administrator out', async () => {
    const user = userEvent.setup();
    const handlers = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Back to clock-in' }));

    expect(handlers.onBackToClockIn).toHaveBeenCalledTimes(1);
  });
});
