import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, getTheme, setTheme, useTheme } from './theme';

describe('theme', () => {
  afterEach(() => setTheme('system'));

  it('follows the system until the viewer chooses', () => {
    expect(getTheme()).toBe('system');
  });

  it('switches the page to dark and remembers the choice', () => {
    setTheme('dark');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(getTheme()).toBe('dark');
  });

  it('switches back to light', () => {
    setTheme('dark');
    setTheme('light');

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(getTheme()).toBe('light');
  });

  it('applies a theme without changing the stored choice', () => {
    applyTheme('dark');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(getTheme()).toBe('system');
  });

  it('redraws components when the theme changes', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('system');

    act(() => setTheme('dark'));

    expect(result.current).toBe('dark');
  });
});
