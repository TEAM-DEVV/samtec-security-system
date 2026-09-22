import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCursorPages } from './cursor-pages';

describe('useCursorPages', () => {
  it('starts on the first page with nothing to go back to', () => {
    const { result } = renderHook(() => useCursorPages());

    expect(result.current.cursor).toBeUndefined();
    expect(result.current.canGoBack).toBe(false);
  });

  it('walks forward with the API bookmarks and back again', () => {
    const { result } = renderHook(() => useCursorPages());

    act(() => result.current.goForward('page-2', false));
    expect(result.current.cursor).toBe('page-2');
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.goForward('page-3', false));
    expect(result.current.cursor).toBe('page-3');

    act(() => result.current.goBack());
    expect(result.current.cursor).toBe('page-2');

    act(() => result.current.goBack());
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.canGoBack).toBe(false);
  });

  it('ignores forward clicks on the last page and while a page is loading', () => {
    const { result } = renderHook(() => useCursorPages());

    act(() => result.current.goForward(null, false));
    expect(result.current.cursor).toBeUndefined();

    act(() => result.current.goForward('page-2', true));
    expect(result.current.cursor).toBeUndefined();
  });

  it('ignores a repeated forward with the same bookmark', () => {
    const { result } = renderHook(() => useCursorPages());

    act(() => result.current.goForward('page-2', false));
    act(() => result.current.goForward('page-2', false));

    expect(result.current.cursor).toBe('page-2');
    act(() => result.current.goBack());
    expect(result.current.cursor).toBeUndefined();
  });

  it('goes back to the first page when a filter changes', () => {
    const { result } = renderHook(() => useCursorPages());
    act(() => result.current.goForward('page-2', false));

    act(() => result.current.reset());

    expect(result.current.cursor).toBeUndefined();
    expect(result.current.canGoBack).toBe(false);
  });

  it('never goes back past the first page', () => {
    const { result } = renderHook(() => useCursorPages());

    act(() => result.current.goBack());

    expect(result.current.cursor).toBeUndefined();
    expect(result.current.canGoBack).toBe(false);
  });
});
