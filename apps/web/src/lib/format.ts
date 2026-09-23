/**
 * Display helpers. Use these everywhere instead of formatting by hand, so money
 * and dates look the same on every screen.
 */

const wholeCedis = new Intl.NumberFormat('en-GH', { maximumFractionDigits: 0 });

/**
 * Formats money for display. The API always sends money as a whole number of
 * pesewas (GHS 1.00 = 100 pesewas), so the maths stays exact:
 *
 *   formatCedis(123456) → "GH₵ 1,234.56"
 */
export function formatCedis(amountPesewas: number): string {
  if (!Number.isSafeInteger(amountPesewas)) {
    throw new TypeError(`Money must be a whole number of pesewas, but got ${amountPesewas}.`);
  }
  const absolute = Math.abs(amountPesewas);
  const pesewas = absolute % 100;
  const cedis = (absolute - pesewas) / 100;
  const sign = amountPesewas < 0 ? '-' : '';
  return `${sign}GH₵ ${wholeCedis.format(cedis)}.${String(pesewas).padStart(2, '0')}`;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const calendarDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * Formats a calendar date from the API ("2026-09-15") as "15 Sept 2026".
 * A calendar date has no time zone, so it is read and shown in UTC and can
 * never shift by a day on a computer set to another time zone.
 *
 * For a timestamp such as "2026-09-15T08:30:00Z", use `formatDateTime` instead.
 */
export function formatDate(isoDate: string): string {
  if (!CALENDAR_DATE.test(isoDate)) {
    throw new TypeError(
      `formatDate expects a calendar date like "2026-09-15", but got "${isoDate}". Use formatDateTime for timestamps.`,
    );
  }
  return calendarDate.format(new Date(`${isoDate}T00:00:00Z`));
}

const ghanaDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Formats a timestamp from the API ("2026-09-15T08:30:00Z") in Ghana time:
 * "15 Sept 2026, 08:30". Always Africa/Accra, even when the viewer's computer
 * is set to another time zone.
 */
export function formatDateTime(isoTimestamp: string): string {
  return ghanaDateTime.format(new Date(isoTimestamp));
}

const ghanaLongDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** A date in Ghana time, spelled out: "Monday, 21 September 2026". Defaults to now. */
export function formatLongDate(date: Date = new Date()): string {
  return ghanaLongDate.format(date);
}

const ghanaHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  hour: 'numeric',
  hourCycle: 'h23',
});

/** "Good morning", "Good afternoon" or "Good evening", by the clock in Ghana. */
export function greetingForNow(now: Date = new Date()): string {
  const hour = Number(ghanaHour.format(now));
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 17) {
    return 'Good afternoon';
  }
  return 'Good evening';
}

function nameParts(fullName: string): string[] {
  return fullName.trim().split(/\s+/).filter(Boolean);
}

/** The first name, for a greeting: "Kwame Kofi Mensah" → "Kwame". */
export function firstName(fullName: string): string {
  return nameParts(fullName)[0] ?? fullName;
}

/** Up to two initials for an avatar: "Kwame Kofi Mensah" → "KM". */
export function initials(fullName: string): string {
  const parts = nameParts(fullName);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

const ghanaTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Only the clock time of a timestamp, in Ghana: "2026-09-15T08:30:00Z" → "08:30". */
export function formatTime(isoTimestamp: string): string {
  return ghanaTime.format(new Date(isoTimestamp));
}

const ghanaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** The clock time to the second, in Ghana, for a board that refreshes every few seconds: "08:30:07". */
export function formatClock(date: Date | number): string {
  return ghanaClock.format(date);
}

/** Worked minutes as hours and minutes: 725 → "12h 05m". */
export function formatMinutes(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new TypeError(`Minutes must be a whole number of at least 0, but got ${minutes}.`);
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const ghanaIsoDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Accra',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar date in Ghana, as the API writes dates: "2026-09-23". Defaults to now. */
export function todayInGhana(now: Date = new Date()): string {
  return ghanaIsoDate.format(now);
}

/** A calendar date moved by some days: addDays("2026-09-23", -7) → "2026-09-16". */
export function addDays(isoDate: string, days: number): string {
  if (!CALENDAR_DATE.test(isoDate)) {
    throw new TypeError(`addDays expects a calendar date like "2026-09-15", but got "${isoDate}".`);
  }
  const moved = new Date(`${isoDate}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * A timestamp as a `datetime-local` input wants it, in Ghana time. Ghana is
 * UTC+0 all year, so the clock time in the ISO string is already Ghana time.
 */
export function toGhanaLocalInput(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().slice(0, 16);
}

/** The reverse: a `datetime-local` value typed in Ghana time, as the API wants it (UTC). */
export function fromGhanaLocalInput(value: string): string {
  return `${value}:00Z`;
}
