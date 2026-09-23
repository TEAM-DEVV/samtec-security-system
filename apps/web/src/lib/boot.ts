/**
 * The boot screen: index.html shows the brand mark from the first paint, and
 * the dashboard fades it away once it has rendered. This file holds the
 * timing rules so they can be tested; main.tsx only wires them to the page.
 */

/** How long the boot screen stays the first time a tab opens the dashboard, so it never just flickers. */
export const BOOT_MIN_MS = 1100;
/** If the fade's `transitionend` never fires (a hidden tab, for example), remove the screen anyway. */
export const FADE_FALLBACK_MS = 700;
const BOOT_SEEN_KEY = 'samtec-boot-seen';

/** The two storage calls the boot screen needs; `sessionStorage` in the browser. */
export type BootStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface DismissBootOptions {
  /** The boot screen element, or null when the page has none. */
  boot: HTMLElement | null;
  /** The page element that was `inert` while the boot screen covered it. */
  root: HTMLElement | null;
  /** True when the person asked their device for less motion. */
  reducedMotion: boolean;
  /** Milliseconds since the page started loading. */
  elapsedMs: number;
  /** Where the "seen before" note lives, or null when storage is blocked. */
  storage: BootStorage | null;
}

/**
 * Lets the page take focus again, then fades the boot screen away: at once
 * when motion is reduced or this tab has shown it before, otherwise after the
 * minimum time so the brand mark is actually seen.
 */
export function dismissBoot({ boot, root, reducedMotion, elapsedMs, storage }: DismissBootOptions) {
  root?.removeAttribute('inert');
  if (!boot) {
    return;
  }
  const remove = () => boot.remove();
  if (reducedMotion) {
    remove();
    return;
  }
  const wait = markSeen(storage) ? 0 : Math.max(0, BOOT_MIN_MS - elapsedMs);
  setTimeout(() => {
    boot.classList.add('is-done');
    boot.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, FADE_FALLBACK_MS);
  }, wait);
}

/** Notes that this tab has shown the boot screen, and says whether it had before. Blocked storage counts as a first visit. */
function markSeen(storage: BootStorage | null): boolean {
  try {
    const seen = storage?.getItem(BOOT_SEEN_KEY) === 'yes';
    storage?.setItem(BOOT_SEEN_KEY, 'yes');
    return seen;
  } catch {
    return false;
  }
}

/** `sessionStorage`, or null when the browser refuses to even hand it over (some privacy settings do). */
export function sessionStorageOrNull(): BootStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
