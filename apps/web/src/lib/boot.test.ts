import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_MIN_MS, type BootStorage, dismissBoot, FADE_FALLBACK_MS } from './boot';

/** A page with the boot screen over an `inert` root, as index.html sets it up. */
function makePage() {
  const boot = document.createElement('div');
  boot.id = 'boot';
  const root = document.createElement('div');
  root.setAttribute('inert', '');
  document.body.append(boot, root);
  return { boot, root };
}

/** A pretend sessionStorage that remembers one value. */
function makeStorage(initial?: string): BootStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set('samtec-boot-seen', initial);
  }
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('dismissBoot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('lets the page take focus and removes the screen at once when motion is reduced', () => {
    const { boot, root } = makePage();

    dismissBoot({ boot, root, reducedMotion: true, elapsedMs: 0, storage: makeStorage() });

    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.body.contains(boot)).toBe(false);
  });

  it('keeps the screen for the minimum time on a first visit, then fades it out', () => {
    const { boot, root } = makePage();
    const storage = makeStorage();

    dismissBoot({ boot, root, reducedMotion: false, elapsedMs: 200, storage });

    expect(root.hasAttribute('inert')).toBe(false);
    vi.advanceTimersByTime(BOOT_MIN_MS - 200 - 1);
    expect(boot.classList.contains('is-done')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(boot.classList.contains('is-done')).toBe(true);
    // The tab remembers that the brand mark has been shown.
    expect(storage.values.get('samtec-boot-seen')).toBe('yes');

    boot.dispatchEvent(new Event('transitionend'));
    expect(document.body.contains(boot)).toBe(false);
  });

  it('fades out straight away when this tab has shown the screen before', () => {
    const { boot, root } = makePage();

    dismissBoot({ boot, root, reducedMotion: false, elapsedMs: 50, storage: makeStorage('yes') });

    vi.advanceTimersByTime(0);
    expect(boot.classList.contains('is-done')).toBe(true);
  });

  it('removes the screen even if the fade never reports finishing', () => {
    const { boot, root } = makePage();

    dismissBoot({ boot, root, reducedMotion: false, elapsedMs: 50, storage: makeStorage('yes') });

    vi.advanceTimersByTime(FADE_FALLBACK_MS - 1);
    expect(document.body.contains(boot)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(document.body.contains(boot)).toBe(false);
  });

  it('treats blocked storage as a first visit', () => {
    const { boot, root } = makePage();
    const blocked: BootStorage = {
      getItem: () => {
        throw new Error('Storage is disabled.');
      },
      setItem: () => {
        throw new Error('Storage is disabled.');
      },
    };

    dismissBoot({ boot, root, reducedMotion: false, elapsedMs: 0, storage: blocked });

    vi.advanceTimersByTime(BOOT_MIN_MS - 1);
    expect(boot.classList.contains('is-done')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(boot.classList.contains('is-done')).toBe(true);
  });

  it('does nothing but free the page when there is no boot screen', () => {
    const root = document.createElement('div');
    root.setAttribute('inert', '');

    dismissBoot({ boot: null, root, reducedMotion: false, elapsedMs: 0, storage: null });

    expect(root.hasAttribute('inert')).toBe(false);
  });
});
