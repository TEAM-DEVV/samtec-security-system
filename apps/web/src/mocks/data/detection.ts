import type { DetectionAlert, DetectionRule } from '@samtec/contracts';
import { mockEmployees } from './employees';
import { mockSites } from './sites';

/**
 * Fictional ghost-detection findings, so the queue can be built before the
 * engine exists (docs/plan/08-ghost-detection-engine.md).
 *
 * The three planted anomalies are the ones the exit demo has to catch: a
 * worker on the payroll with no punches, one person enrolled twice, and a
 * guard clocked in at two sites at once. Everything here is invented.
 */

const employee = (index: number) => {
  const person = mockEmployees[index];
  if (!person) {
    throw new Error('The mock employee list changed shape.');
  }
  return { id: person.id, staffNumber: person.staffNumber, fullName: person.fullName };
};

const site = (index: number) => mockSites[index]?.id ?? null;

export const DETECTION_RULES: readonly DetectionRule[] = [
  {
    code: 'R1',
    name: 'Duplicate enrollment',
    description: 'One face enrolled twice, under two names.',
    severity: 'CRITICAL',
    enabled: true,
    thresholds: {},
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R2',
    name: 'Identity collision',
    description: 'Two workers sharing a phone number, bank account or mobile money number.',
    severity: 'HIGH',
    enabled: true,
    thresholds: { sharedBy: 2 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R3',
    name: 'Paid without presence',
    description: 'A payslip paying more hours than the recorded shifts support.',
    severity: 'CRITICAL',
    enabled: true,
    thresholds: { toleranceMinutes: 60 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R4',
    name: 'Bilocation',
    description: 'One worker on shift at two sites at the same time, more than once.',
    severity: 'HIGH',
    enabled: true,
    thresholds: { overlaps: 3, days: 30 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R5',
    name: 'Never seen',
    description: 'On the books for a fortnight and never once clocked in.',
    severity: 'HIGH',
    enabled: true,
    thresholds: { days: 14 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R6',
    name: 'Terminated but active',
    description: 'Punches or pay after the day the worker left.',
    severity: 'CRITICAL',
    enabled: true,
    thresholds: {},
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R7',
    name: 'Fallback abuse',
    description: 'A worker, or a supervisor, leaning on the ways around the camera.',
    severity: 'MEDIUM',
    enabled: true,
    thresholds: { sharePercent: 40, days: 30, minimumClockIns: 5, supervisorCoSigns: 20 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R8',
    name: 'Robot regularity',
    description: 'Clock-in times too alike to be a person walking to work.',
    severity: 'MEDIUM',
    enabled: true,
    thresholds: { standardDeviationMinutes: 3, workingDays: 10 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R9',
    name: 'Device anomaly',
    description: 'A terminal sending far more punches than it ever has, or with a wandering clock.',
    severity: 'MEDIUM',
    enabled: true,
    thresholds: { volumeMultiple: 3, medianDays: 30, clockDriftMinutes: 5 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R10',
    name: 'Orphan punches',
    description: 'A device user number that matches nobody, again and again.',
    severity: 'MEDIUM',
    enabled: true,
    thresholds: { punches: 5, days: 7 },
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
  {
    code: 'R11',
    name: 'Conflicted decision',
    description: 'A two-person decision settled by somebody who should not have settled it.',
    severity: 'HIGH',
    enabled: true,
    thresholds: {},
    updatedAt: '2026-09-01T08:00:00.000Z',
  },
];

export const DETECTION_ALERTS: readonly DetectionAlert[] = [
  {
    id: '01927c3e-5100-7000-8000-000000000001',
    ruleCode: 'R5',
    severity: 'HIGH',
    status: 'OPEN',
    subject: { employee: employee(9), device: null, siteId: site(0) },
    windowFrom: '2026-08-25',
    windowTo: '2026-09-22',
    evidence: { daysOnTheBooks: 29, punches: 0, hiredOn: '2026-08-25' },
    openedAt: '2026-09-22T02:00:00.000Z',
    resolution: null,
  },
  {
    id: '01927c3e-5100-7000-8000-000000000002',
    ruleCode: 'R1',
    severity: 'CRITICAL',
    status: 'OPEN',
    subject: { employee: employee(4), device: null, siteId: site(1) },
    windowFrom: '2026-09-18',
    windowTo: '2026-09-18',
    evidence: {
      lookedLikeStaffNumber: mockEmployees[5]?.staffNumber ?? 'SMT-00006',
      similarity: 0.71,
      credentialId: '01927c3e-4200-7000-8000-000000000004',
    },
    openedAt: '2026-09-18T11:14:00.000Z',
    resolution: null,
  },
  {
    id: '01927c3e-5100-7000-8000-000000000003',
    ruleCode: 'R4',
    severity: 'HIGH',
    status: 'UNDER_REVIEW',
    subject: { employee: employee(2), device: null, siteId: site(0) },
    windowFrom: '2026-08-23',
    windowTo: '2026-09-22',
    evidence: { overlaps: 3, sites: ['Ridge Towers', 'Airport Cargo Village'] },
    openedAt: '2026-09-21T02:00:00.000Z',
    resolution: null,
  },
  {
    id: '01927c3e-5100-7000-8000-000000000004',
    ruleCode: 'R7',
    severity: 'MEDIUM',
    status: 'OPEN',
    subject: { employee: employee(6), device: null, siteId: site(0) },
    windowFrom: '2026-08-23',
    windowTo: '2026-09-22',
    evidence: { clockIns: 22, flagged: 11, sharePercent: 50 },
    openedAt: '2026-09-22T02:00:00.000Z',
    resolution: null,
  },
  {
    id: '01927c3e-5100-7000-8000-000000000005',
    ruleCode: 'R9',
    severity: 'MEDIUM',
    status: 'RESOLVED',
    subject: {
      employee: null,
      device: { id: '01927c3e-3100-7000-8000-000000000002', name: 'ACC-01 Main Gate' },
      siteId: site(0),
    },
    windowFrom: '2026-09-10',
    windowTo: '2026-09-11',
    evidence: { punchesThatDay: 143, medianPunches: 38, multiple: 3.8 },
    openedAt: '2026-09-11T02:00:00.000Z',
    resolution: {
      decidedByUserId: '01927c3e-1000-7000-8000-000000000001',
      decidedAt: '2026-09-11T09:30:00.000Z',
      note: 'Client event day, double shift across every post. Checked the roster.',
    },
  },
];
