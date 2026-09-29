/**
 * The SAMTEC mark.
 *
 * Inline SVG rather than an image file, for the same reason this app has no
 * framework: a kiosk boots on a cheap Android phone at a gate, and an image is
 * one more request to wait for. This is about 400 bytes and arrives with the
 * page.
 *
 * A shield, because that is what the company does, with a stylised face inside
 * it — recognisable at arm's length, which is how far away a guard stands.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      // Decorative: the word SAMTEC is beside it, so a screen reader that
      // announced this too would say the name twice.
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M16 2.5 4.5 6.8v9.4c0 6.6 4.7 11.6 11.5 13.3 6.8-1.7 11.5-6.7 11.5-13.3V6.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* The head and shoulders: the thing the camera is looking for. */}
      <circle cx="16" cy="13" r="3.4" fill="currentColor" />
      <path
        d="M9.8 23.4c1.1-3.4 3.4-5.2 6.2-5.2s5.1 1.8 6.2 5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
