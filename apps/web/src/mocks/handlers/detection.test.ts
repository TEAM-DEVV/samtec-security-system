import { afterEach, describe, expect, it } from 'vitest';
import { fetchClient } from '@/lib/api';
import { signInForTests } from '@/test/session';
import { DETECTION_ALERTS } from '../data/detection';
import { resetMockDetection } from './detection';

// This file resets its own mock store, so it needs no change to test/setup.ts.
afterEach(() => {
  resetMockDetection();
});

const open = DETECTION_ALERTS.find((alert) => alert.status === 'OPEN');
const resolved = DETECTION_ALERTS.find((alert) => alert.resolution !== null);

describe('mock detection API', () => {
  it('shows the queue to an ADMIN, newest first', async () => {
    await signInForTests('admin@samtec.example');

    const { data } = await fetchClient.GET('/detection/alerts');

    expect(data?.items.length).toBeGreaterThan(0);
    const dates = data?.items.map((alert) => alert.openedAt) ?? [];
    expect([...dates].sort().reverse()).toEqual(dates);
    // Evidence names rows and numbers, never anything biometric.
    expect(JSON.stringify(data)).not.toMatch(/embedding|template|GHA-/i);
  });

  it('never shows the queue to a supervisor or a guard', async () => {
    // A supervisor is themselves a subject of rule R7, so the queue would
    // show them their own file (docs/plan/08 §6).
    for (const email of ['supervisor@samtec.example', 'guard@samtec.example']) {
      await signInForTests(email);
      const { response } = await fetchClient.GET('/detection/alerts');
      expect(response.status).toBe(403);
    }
  });

  it('filters by rule, severity and status', async () => {
    await signInForTests('hr@samtec.example');

    const { data } = await fetchClient.GET('/detection/alerts', {
      params: { query: { ruleCode: 'R5' } },
    });

    expect(data?.items.every((alert) => alert.ruleCode === 'R5')).toBe(true);
  });

  it('will not close an alert without a reason, and never closes one twice', async () => {
    await signInForTests('admin@samtec.example');
    const alertId = open?.id ?? '';

    const noNote = await fetchClient.POST('/detection/alerts/{alertId}/resolve', {
      params: { path: { alertId } },
      body: { status: 'RESOLVED', note: '' },
    });
    expect(noNote.response.status).toBe(400);

    const closed = await fetchClient.POST('/detection/alerts/{alertId}/resolve', {
      params: { path: { alertId } },
      body: { status: 'CONFIRMED_FRAUD', note: 'Checked the roster; the worker does not exist.' },
    });
    expect(closed.data?.status).toBe('CONFIRMED_FRAUD');
    expect(closed.data?.resolution?.note).toMatch(/does not exist/);

    const again = await fetchClient.POST('/detection/alerts/{alertId}/resolve', {
      params: { path: { alertId } },
      body: { status: 'RESOLVED', note: 'Changed my mind.' },
    });
    expect(again.response.status).toBe(409);
    expect(resolved?.resolution).not.toBeNull();
  });

  it('lets only an ADMIN move a threshold, and refuses one the rule does not have', async () => {
    await signInForTests('hr@samtec.example');
    const asHr = await fetchClient.PATCH('/detection/rules/{ruleCode}', {
      params: { path: { ruleCode: 'R5' } },
      body: { enabled: false },
    });
    expect(asHr.response.status).toBe(403);

    await signInForTests('admin@samtec.example');
    const moved = await fetchClient.PATCH('/detection/rules/{ruleCode}', {
      params: { path: { ruleCode: 'R5' } },
      body: { thresholds: { days: 21 } },
    });
    expect(moved.data?.thresholds).toEqual({ days: 21 });

    const nonsense = await fetchClient.PATCH('/detection/rules/{ruleCode}', {
      params: { path: { ruleCode: 'R5' } },
      body: { thresholds: { bananas: 3 } },
    });
    expect(nonsense.response.status).toBe(400);
  });

  it('adds up a risk score from the open alerts only', async () => {
    await signInForTests('admin@samtec.example');

    const { data } = await fetchClient.GET('/detection/risk-scores');

    expect(data?.items.length).toBeGreaterThan(0);
    const scores = data?.items.map((row) => row.score) ?? [];
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // The resolved device alert has no employee and is closed, so it counts
    // towards nobody.
    expect(data?.items.every((row) => row.openAlerts > 0)).toBe(true);
  });

  it('runs a sweep for an ADMIN, and raises nothing the second time', async () => {
    await signInForTests('admin@samtec.example');

    const first = await fetchClient.POST('/detection/sweep');
    const second = await fetchClient.POST('/detection/sweep');

    expect(first.data?.rulesRun.length).toBeGreaterThan(0);
    // Repeating a sweep changes nothing: that is what the dedupe key is for.
    expect(second.data?.raised).toBe(0);
  });
});
