import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PairedDevice } from '@/lib/device';
import { PairingScreen } from './pairing-screen';

/**
 * Setting a phone up as a kiosk.
 *
 * `pairDevice` is stubbed, because IndexedDB in jsdom is a different thing from
 * IndexedDB on an Android phone and testing jsdom's copy would prove nothing
 * about the real one. What is tested here is what this screen is for: refusing
 * a mistyped secret before anything is stored, and never leaving the secret
 * readable on a screen that hangs on a wall.
 *
 * That the key itself cannot be read back is proved in `lib/signing.test.ts`,
 * against the browser's real WebCrypto.
 */
const A_REAL_LOOKING_ID = '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01';
const A_REAL_LOOKING_SECRET = 'sk_live_0123456789abcdefghij';

const paired = vi.hoisted(() => vi.fn());
vi.mock('@/lib/device', () => ({
  pairDevice: paired,
}));

afterEach(() => {
  paired.mockReset();
});

function fill() {
  return {
    name: screen.getByLabelText('What to call this kiosk'),
    id: screen.getByLabelText('Device ID'),
    secret: screen.getByLabelText('Device secret'),
    finish: screen.getByRole('button', { name: 'Finish set-up' }),
  };
}

describe('PairingScreen', () => {
  it('pairs the phone and hands the device back', async () => {
    const device: PairedDevice = {
      deviceId: A_REAL_LOOKING_ID,
      name: 'Main Gate kiosk',
      key: {} as CryptoKey,
      pairedAt: '2026-09-26T06:00:00.000Z',
    };
    paired.mockResolvedValue(device);
    const onPaired = vi.fn();
    const user = userEvent.setup();
    render(<PairingScreen onPaired={onPaired} />);

    const form = fill();
    await user.type(form.name, 'Main Gate kiosk');
    await user.type(form.id, A_REAL_LOOKING_ID);
    await user.type(form.secret, A_REAL_LOOKING_SECRET);
    await user.click(form.finish);

    expect(paired).toHaveBeenCalledWith(
      A_REAL_LOOKING_ID,
      A_REAL_LOOKING_SECRET,
      'Main Gate kiosk',
    );
    expect(onPaired).toHaveBeenCalledWith(device);
  });

  it('refuses a device ID that is not one, before storing anything', async () => {
    const user = userEvent.setup();
    render(<PairingScreen onPaired={vi.fn()} />);

    const form = fill();
    await user.type(form.id, 'main-gate');
    await user.type(form.secret, A_REAL_LOOKING_SECRET);
    await user.click(form.finish);

    expect(await screen.findByRole('alert')).toHaveTextContent(/device ID does not look right/);
    // Nothing was stored, so a mistyped ID cannot leave a half-set-up phone.
    expect(paired).not.toHaveBeenCalled();
  });

  it('refuses a secret that was clearly not copied whole', async () => {
    const user = userEvent.setup();
    render(<PairingScreen onPaired={vi.fn()} />);

    const form = fill();
    await user.type(form.id, A_REAL_LOOKING_ID);
    await user.type(form.secret, 'sk_live_short');
    await user.click(form.finish);

    expect(await screen.findByRole('alert')).toHaveTextContent(/too short/);
    expect(paired).not.toHaveBeenCalled();
  });

  it('never shows the secret on screen', () => {
    render(<PairingScreen onPaired={vi.fn()} />);
    // This phone hangs on a wall where anybody walking past can read it.
    expect(screen.getByLabelText('Device secret')).toHaveAttribute('type', 'password');
  });

  it('says what to do when the phone will not store the key', async () => {
    paired.mockRejectedValue(new Error('no'));
    const user = userEvent.setup();
    render(<PairingScreen onPaired={vi.fn()} />);

    const form = fill();
    await user.type(form.id, A_REAL_LOOKING_ID);
    await user.type(form.secret, A_REAL_LOOKING_SECRET);
    await user.click(form.finish);

    // Private mode and blocked site data both land here, and telling them apart
    // is guesswork — so the message says what to do instead of what went wrong.
    expect(await screen.findByRole('alert')).toHaveTextContent(/not in private mode/);
    // And the button comes back, so it can be tried again.
    expect(screen.getByRole('button', { name: 'Finish set-up' })).toBeEnabled();
  });

  it('falls back to a plain name rather than an empty one', async () => {
    paired.mockResolvedValue({} as PairedDevice);
    const user = userEvent.setup();
    render(<PairingScreen onPaired={vi.fn()} />);

    const form = fill();
    await user.type(form.id, A_REAL_LOOKING_ID);
    await user.type(form.secret, A_REAL_LOOKING_SECRET);
    await user.click(form.finish);

    expect(paired).toHaveBeenCalledWith(A_REAL_LOOKING_ID, A_REAL_LOOKING_SECRET, 'This kiosk');
  });
});
