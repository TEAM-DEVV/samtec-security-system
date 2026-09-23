import { z } from 'zod';

/**
 * Every input the detection endpoints take. `strictObject` refuses a field we
 * did not ask for, so nothing can be slipped into an alert from outside.
 */

const limit = z.coerce.number().int().min(1).max(100).default(25);
const cursor = z.string().min(1).max(200);

export const ruleCodeSchema = z.enum([
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
]);

/** Contract: the `listDetectionAlerts` query. */
export const listAlertsQuerySchema = z.strictObject({
  status: z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CONFIRMED_FRAUD']).optional(),
  ruleCode: ruleCodeSchema.optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM']).optional(),
  employeeId: z.uuid().optional(),
  limit,
  cursor: cursor.optional(),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

/** Contract: `ResolveDetectionAlertRequest`. Only these two close an alert. */
export const resolveAlertSchema = z.strictObject({
  status: z.enum(['RESOLVED', 'CONFIRMED_FRAUD']),
  note: z.string().trim().min(3).max(500),
});
export type ResolveAlertBody = z.infer<typeof resolveAlertSchema>;

/** Contract: `UpdateDetectionRuleRequest`. */
export const updateDetectionRuleSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    // A threshold is always a number: the rules do arithmetic with them.
    thresholds: z.record(z.string(), z.number()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.');
export type UpdateDetectionRuleBody = z.infer<typeof updateDetectionRuleSchema>;

/** Contract: the `listRiskScores` query. */
export const riskScoresQuerySchema = z.strictObject({ limit });
export type RiskScoresQuery = z.infer<typeof riskScoresQuerySchema>;
