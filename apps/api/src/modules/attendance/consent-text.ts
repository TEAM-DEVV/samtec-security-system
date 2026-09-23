import { createHash } from 'node:crypto';

/**
 * The words a worker reads before their face is enrolled, and the only place
 * they are written (docs/plan/13-biometrics-design.md section 2). The kiosk
 * and the dashboard both show exactly this, and every consent record keeps
 * the SHA-256 of it, so years later anyone can prove what was agreed to.
 *
 * Changing a single character means a new version: the old records keep
 * pointing at the old words, which is the whole point of storing the hash.
 */
export const CONSENT_TEXT_VERSION = 'bio-v1';

export const CONSENT_TEXT = `Using your face to record your working hours

Why we ask. Your employer records when you start and finish work so that you
are paid correctly for every hour you work.

What is kept. A camera at this device measures your face and turns it into a
list of numbers. Only those numbers are kept, locked with a key held outside
the database. No photograph of you is kept, here or anywhere else.

Where it is used. The numbers are used only to recognise you when you start
and finish a shift at your own workplace, and to make sure nobody is enrolled
twice under two names.

How long it is kept. While you work here, and for 90 days after you leave.
After that your face is deleted. The record that you worked stays, because
your employer must keep pay records.

Your choices. You do not have to agree. If you would rather not, tell the
administrator: you can clock in with your supervisor confirming it instead,
and you will be paid in full for the same hours. You can also change your mind
later, and your face will be deleted at once.

Your rights. You may ask to see what is held about you, ask for a mistake to
be corrected, or complain to the Data Protection Commission of Ghana.

By tapping "I agree", you are saying that this was explained to you and that
you agree to your face being used in this way.`;

/** The SHA-256 of the exact words above, as every consent record stores it. */
export const CONSENT_TEXT_SHA256 = createHash('sha256').update(CONSENT_TEXT, 'utf8').digest('hex');
