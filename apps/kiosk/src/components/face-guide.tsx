import type { HeadTurn } from '@/lib/face';

/** What the guide is doing, which decides its colour and what it draws. */
export type GuideState = 'waiting' | 'turn' | 'centre' | 'good' | 'bad';

interface FaceGuideProps {
  state: GuideState;
  /** Which way to turn, when that is what is being asked. */
  turn?: HeadTurn | null;
  /** How far through the time limit, 0 to 1, for the ring. */
  progress?: number;
}

/**
 * The oval a face goes in, drawn over the camera.
 *
 * A guard at a gate does not read instructions. Before this, the camera was a
 * bare rectangle with a sentence under it, and the only way to know where to
 * stand was to guess. Now there is a shape to fill and an arrow pointing the way
 * to turn — which is also the part that works for somebody who reads little, or
 * who is looking at a screen in bright sun.
 *
 * Everything here is drawn, not written: an SVG overlay costs nothing to load and
 * scales to any phone. Nothing is said by colour alone — the words underneath
 * always say the same thing as the shape, because a sun-bleached screen and
 * colour blindness are the same problem at a gate.
 */
export function FaceGuide({ state, turn, progress = 0 }: FaceGuideProps) {
  // The ring runs down as the time does, so a person can see they are not stuck.
  const circumference = 2 * Math.PI * 47;
  const left = Math.max(0, Math.min(1, 1 - progress));

  return (
    <svg
      className={`guide guide--${state}`}
      viewBox="0 0 120 160"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {/* The oval to fill. Dashed while waiting, solid once a face is in it, so
          the change is a shape change and not only a colour change. */}
      <ellipse
        className="guide__oval"
        cx="60"
        cy="66"
        rx="34"
        ry="44"
        fill="none"
        strokeWidth="2.5"
        strokeDasharray={state === 'waiting' ? '7 7' : undefined}
      />

      {/* The time left, as a ring. Only while something is being waited for. */}
      {(state === 'turn' || state === 'centre') && (
        <circle
          className="guide__ring"
          cx="60"
          cy="66"
          r="47"
          fill="none"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - left)}
          transform="rotate(-90 60 66)"
        />
      )}

      {/* The arrow, on the side the head should move towards. Mirrored, because
          the camera image is mirrored — an arrow on the wrong side sends every
          person the wrong way the first time. */}
      {state === 'turn' && turn != null && (
        <g
          className="guide__arrow"
          transform={turn === 'LEFT' ? '' : 'translate(120 0) scale(-1 1)'}
        >
          <path
            d="M26 66 h-13 M18 59 l-7 7 7 7"
            fill="none"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}

      {/* Look straight ahead: two marks either side of the oval, level with the
          eyes, rather than another arrow. */}
      {state === 'centre' && (
        <g className="guide__arrow">
          <path d="M22 60 h8 M98 60 h-8" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        </g>
      )}
    </svg>
  );
}
