import { createHmac } from 'node:crypto';

/**
 * The fictional demo company's clock-in terminals: one MOCK device per seeded
 * site. `pnpm db:seed` registers them and `pnpm --filter @samtec/api
 * mock:devices` plays them. Two of them misbehave on purpose, so the demo
 * shows what the API does about it.
 */
export interface DemoDevice {
  siteCode: string;
  name: string;
  /** The terminal's clock runs this many seconds fast (its punches get flagged). */
  clockDriftSeconds?: number;
  /** Sends its last batch twice, as if an acknowledgement got lost (all DUPLICATE). */
  resendsLastBatch?: boolean;
}

export const DEMO_DEVICES: DemoDevice[] = [
  { siteCode: 'ACC-01', name: 'Demo terminal ACC-01' },
  { siteCode: 'ACC-02', name: 'Demo terminal ACC-02' },
  { siteCode: 'TEM-01', name: 'Demo terminal TEM-01', clockDriftSeconds: 420 },
  { siteCode: 'KSI-01', name: 'Demo terminal KSI-01' },
  { siteCode: 'TKD-01', name: 'Demo terminal TKD-01', resendsLastBatch: true },
];

/**
 * A demo device's secret, derived from AUTH_SECRET and the device's name. The
 * simulator on the same computer computes the same value, so the secret is
 * never printed or stored in plain text. Anyone who knows AUTH_SECRET could
 * compute it, which is why the seed only registers these devices in a
 * database on this computer. Real devices get 32 random bytes, shown once
 * (docs/plan/12 §1).
 */
export function demoDeviceSecret(authSecret: string, deviceName: string): string {
  return createHmac('sha256', authSecret)
    .update(`samtec-demo-device:${deviceName}`)
    .digest('base64url');
}
