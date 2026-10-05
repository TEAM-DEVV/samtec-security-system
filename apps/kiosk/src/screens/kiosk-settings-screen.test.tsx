import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as deviceLib from '@/lib/device';
import { pairDevice } from '@/lib/device';
import { createFakeIndexedDB } from '@/test/fake-indexed-db';
import { KioskSettingsScreen } from './kiosk-settings-screen';

/**
 * Kiosk settings: adding a device, switching between stored devices, and
 * forgetting one. This runs against the real `lib/device.ts`, not a mock of
 * it, against a small fake IndexedDB (`@/test/fake-indexed-db.ts`) — the
 * point of this screen is entirely what it does to that store, so a mock
 * would prove nothing.
 */
const GATE_A = '01927c3e-0000-7000-8000-00000000000a';
const GATE_B = '01927c3e-0000-7000-8000-00000000000b';

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('KioskSettingsScreen', () => {
  it('clears the loading message, rather than sitting beside the error forever', async () => {
    vi.spyOn(deviceLib, 'listDevices').mockRejectedValueOnce(new Error('the store would not open'));

    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={vi.fn()} />);

    expect(
      await screen.findByText('Could not read the devices stored on this phone.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Reading the stored devices…')).not.toBeInTheDocument();
  });

  it('lists the stored devices, with the one most recently paired active', async () => {
    await pairDevice(GATE_A, 'sk_test_only_not_a_real_secret_aaaa', 'Gate A');
    await pairDevice(GATE_B, 'sk_test_only_not_a_real_secret_bbbb', 'Gate B');

    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={vi.fn()} />);

    // Gate B was paired last, so it is active: nothing to switch to on it,
    // and Gate A is offered as somewhere to switch.
    expect(await screen.findByText(/Active now/)).toBeInTheDocument();
    expect(screen.getByText(/Active now/).closest('div')).toHaveTextContent('Gate B');
    expect(screen.getByRole('button', { name: /Switch to Gate A/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to Gate B/ })).not.toBeInTheDocument();
  });

  it('says plainly when nothing is stored yet', async () => {
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={vi.fn()} />);

    expect(await screen.findByText('No device is stored on this phone.')).toBeInTheDocument();
  });

  it('switches the active device on tap, and tells the app', async () => {
    await pairDevice(GATE_A, 'sk_test_only_not_a_real_secret_aaaa', 'Gate A');
    await pairDevice(GATE_B, 'sk_test_only_not_a_real_secret_bbbb', 'Gate B');
    const onDeviceChanged = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={onDeviceChanged} />);

    await user.click(await screen.findByRole('button', { name: /Switch to Gate A/ }));

    await waitFor(() =>
      expect(onDeviceChanged).toHaveBeenCalledWith(expect.objectContaining({ deviceId: GATE_A })),
    );
    // The list redraws around the new active device.
    expect(await screen.findByRole('button', { name: /Switch to Gate B/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to Gate A/ })).not.toBeInTheDocument();
  });

  it('adds a device through the existing pairing form, and returns to the list', async () => {
    const onDeviceChanged = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={onDeviceChanged} />);
    await screen.findByText('No device is stored on this phone.');

    await user.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(await screen.findByRole('heading', { name: 'Set this phone up' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('What to call this kiosk'), 'Side gate');
    await user.type(screen.getByLabelText('Device ID'), '01927c3e-0000-7000-8000-0000000000ff');
    await user.type(screen.getByLabelText('Device secret'), 'sk_test_only_not_a_real_secret_ffff');
    await user.click(screen.getByRole('button', { name: 'Finish set-up' }));

    expect(onDeviceChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: '01927c3e-0000-7000-8000-0000000000ff',
        name: 'Side gate',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Kiosk settings' })).toBeInTheDocument();
    expect(await screen.findByText(/Active now/)).toBeInTheDocument();
    expect(screen.getByText(/Active now/).closest('div')).toHaveTextContent('Side gate');
  });

  it('forgets the active device, falling back to another stored one', async () => {
    await pairDevice(GATE_A, 'sk_test_only_not_a_real_secret_aaaa', 'Gate A');
    await pairDevice(GATE_B, 'sk_test_only_not_a_real_secret_bbbb', 'Gate B');
    const onDeviceChanged = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={onDeviceChanged} />);
    // Gate B is active.
    await screen.findByRole('button', { name: /Switch to Gate A/ });

    await user.click(screen.getByRole('button', { name: 'Forget this device' }));
    await user.click(screen.getByRole('button', { name: 'Yes, forget it' }));

    await waitFor(() =>
      expect(onDeviceChanged).toHaveBeenCalledWith(expect.objectContaining({ deviceId: GATE_A })),
    );
    expect(await screen.findByText(/Active now/)).toBeInTheDocument();
    expect(screen.getByText(/Active now/).closest('div')).toHaveTextContent('Gate A');
  });

  it('falls back to no device at all when the last one is forgotten', async () => {
    await pairDevice(GATE_A, 'sk_test_only_not_a_real_secret_aaaa', 'Gate A');
    const onDeviceChanged = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={onDeviceChanged} />);
    await screen.findByText(/Active now/);

    await user.click(screen.getByRole('button', { name: 'Forget this device' }));
    await user.click(screen.getByRole('button', { name: 'Yes, forget it' }));

    await waitFor(() => expect(onDeviceChanged).toHaveBeenCalledWith(null));
    expect(await screen.findByText('No device is stored on this phone.')).toBeInTheDocument();
  });

  it('asks before forgetting, and keeps the device when told to', async () => {
    await pairDevice(GATE_A, 'sk_test_only_not_a_real_secret_aaaa', 'Gate A');
    const onDeviceChanged = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={onDeviceChanged} />);
    await screen.findByText(/Active now/);

    await user.click(screen.getByRole('button', { name: 'Forget this device' }));
    expect(screen.getByText(/you will need a new secret/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(onDeviceChanged).not.toHaveBeenCalled();
    expect(screen.getByText(/Active now/).closest('div')).toHaveTextContent('Gate A');
  });

  it('leaves the add-a-device form with Cancel, adding nothing', async () => {
    const onDeviceChanged = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={vi.fn()} onDeviceChanged={onDeviceChanged} />);
    await screen.findByText('No device is stored on this phone.');

    await user.click(screen.getByRole('button', { name: 'Add a device' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('heading', { name: 'Kiosk settings' })).toBeInTheDocument();
    expect(onDeviceChanged).not.toHaveBeenCalled();
  });

  it('goes back to the admin menu', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<KioskSettingsScreen onBack={onBack} onDeviceChanged={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Kiosk settings' });

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
