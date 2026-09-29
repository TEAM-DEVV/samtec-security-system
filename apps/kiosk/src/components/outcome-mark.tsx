/** The three answers a kiosk ever gives. */
export type Outcome = 'good' | 'bad' | 'waiting';

/**
 * The big mark that says how it went.
 *
 * A tick, a cross, or a clock, drawn large enough to read from a few paces — so a
 * guard walking away knows their shift started without going back to squint at a
 * sentence. Supervisors watching a queue can see it too.
 *
 * **It never carries the meaning on its own.** Every screen that uses this also
 * says it in words, because colour blindness and a sun-bleached screen are the
 * same problem at a gate, and a shape can be missed as easily as a colour.
 */
export function OutcomeMark({ outcome, size = 84 }: { outcome: Outcome; size?: number }) {
  return (
    <svg
      className={`outcome outcome--${outcome}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="21" fill="none" strokeWidth="2.5" opacity="0.45" />
      {outcome === 'good' && (
        <path
          className="outcome__stroke"
          d="M14 24.5 l7 7 13-14"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {outcome === 'bad' && (
        <path
          className="outcome__stroke"
          d="M16 16 l16 16 M32 16 l-16 16"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
        />
      )}
      {outcome === 'waiting' && (
        <path
          className="outcome__stroke"
          d="M24 13 v12 l8 5"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
