// Applies the viewer's saved theme before the first paint, so the page never
// flashes light before turning dark. Same key and fallback rule as
// src/lib/theme.ts. A real file (not an inline script) so a strict
// Content-Security-Policy allows it with `script-src 'self'`.
(() => {
  try {
    const theme = localStorage.getItem('samtec-theme');
    const dark =
      theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch {
    // Storage blocked: the page starts light and src/lib/theme.ts takes over.
  }
})();
