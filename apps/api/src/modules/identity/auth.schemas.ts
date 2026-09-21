import { z } from 'zod';

/**
 * The rules for every sign-in request body. `strictObject` rejects fields we
 * did not ask for, exactly as the contract's `additionalProperties: false`
 * promises.
 */

export const loginSchema = z.strictObject({
  email: z.email('Enter a valid email address.').max(254),
  password: z.string().min(1, 'Enter your password.').max(128),
});
export type LoginBody = z.infer<typeof loginSchema>;

const oneTimeToken = z.string().min(1).max(512);
const sixDigitCode = z
  .string()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');

export const verifyTwoFactorSchema = z.strictObject({
  challengeToken: oneTimeToken,
  code: sixDigitCode,
});
export type VerifyTwoFactorBody = z.infer<typeof verifyTwoFactorSchema>;

export const twoFactorSetupSchema = z.strictObject({
  setupToken: oneTimeToken,
});
export type TwoFactorSetupBody = z.infer<typeof twoFactorSetupSchema>;

export const enableTwoFactorSchema = z.strictObject({
  setupToken: oneTimeToken,
  code: sixDigitCode,
});
export type EnableTwoFactorBody = z.infer<typeof enableTwoFactorSchema>;

/**
 * Contract: `NewPassword`. Length is the rule that matters (NIST SP 800-63B):
 * at least 12 characters, and at most 128 — the same limit as sign-in, so a
 * saved password can always be typed in again.
 */
export const newPasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters. A short sentence works well.')
  .max(128);

/** Contract: `SetPasswordRequest`. */
export const setPasswordSchema = z.strictObject({
  token: oneTimeToken,
  newPassword: newPasswordSchema,
});
export type SetPasswordBody = z.infer<typeof setPasswordSchema>;

/** Contract: `ChangePasswordRequest`. */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1, 'Enter your current password.').max(128),
  newPassword: newPasswordSchema,
});
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
