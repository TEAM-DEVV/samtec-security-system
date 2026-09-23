import { cn } from 'cn';

interface BrandMarkProps {
  className?: string;
}

/**
 * The SAMTEC shield from favicon.svg, drawn inline so it takes the colour of
 * the text around it: white on the navy sidebar, navy on a light page. The
 * inner badge is always gold. Decorative: the word "SAMTEC" sits beside it.
 *
 * The same shield is drawn in two more places that cannot import this file:
 * `public/favicon.svg` (the browser tab) and the boot screen in `index.html`.
 * Change all three together.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8 shrink-0', className)}
    >
      <path
        d="M16 2 4 6.5v8.2c0 7.6 5.1 13.7 12 15.3 6.9-1.6 12-7.7 12-15.3V6.5L16 2Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        fill="#e8b542"
        d="m16 7.5-6.5 2.4v4.8c0 4.4 2.8 8 6.5 9.1 3.7-1.1 6.5-4.7 6.5-9.1V9.9L16 7.5Z"
      />
    </svg>
  );
}
