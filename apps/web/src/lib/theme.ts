import { useSyncExternalStore } from 'react';

/** Light, dark, or whatever the operating system says. */
export type Theme = 'light' | 'dark' | 'system';

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

/** The same key `index.html` reads before the first paint, so the page never flashes the wrong colours. */
const THEME_KEY = 'samtec-theme';

const listeners = new Set<() => void>();

function isTheme(value: string | null): value is Theme {
  return THEMES.some((theme) => theme === value);
}

/** The viewer's choice, or `system` when they never chose. A per-browser convenience, nothing sensitive. */
export function getTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_KEY) ?? null;
    return isTheme(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function prefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Puts the `dark` class on `<html>` (or removes it) so the CSS variables switch. */
export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // The colour a phone browser paints around the page (brand navy, or the dark background).
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#151b2b' : '#13213a');
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'system') {
      globalThis.localStorage?.removeItem(THEME_KEY);
    } else {
      globalThis.localStorage?.setItem(THEME_KEY, theme);
    }
  } catch {
    // Storage blocked: the choice lasts until the page is closed.
  }
  applyTheme(theme);
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Follow the operating system while the choice is `system`.
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const followSystem = () => {
    if (getTheme() === 'system') {
      applyTheme('system');
    }
  };
  media?.addEventListener('change', followSystem);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', followSystem);
  };
}

/** The current theme choice, for components. They redraw when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => 'system');
}
