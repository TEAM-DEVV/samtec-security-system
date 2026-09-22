import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { MockApiStartError } from './app/mock-api-start-error';
import { env } from './lib/env';
import { applyTheme, getTheme } from './lib/theme';
import './index.css';

// index.html already did this before the first paint; doing it again here
// keeps the page right if that inline script was ever removed.
applyTheme(getTheme());

/** In mock mode, start the pretend API before the app sends its first request. */
async function startMockApi(): Promise<void> {
  // Vite replaces `import.meta.env.DEV` with `false` in production builds, so
  // the bundler can see that the code below never runs and leaves the whole
  // mock API out of the build.
  if (!import.meta.env.DEV || !env.useMocks) {
    return;
  }
  const { worker } = await import('./mocks/browser');
  await worker.start({
    // A request to the SAMTEC API that no mock handler answers is a bug: add a
    // handler in src/mocks/handlers/. The request fails and the browser console
    // explains why. Other requests, such as fonts, pass through untouched.
    onUnhandledRequest(request, print) {
      // The API address may be relative (`/api/v1`), so compare full addresses.
      if (request.url.startsWith(new URL(env.apiBaseUrl, window.location.origin).href)) {
        print.error();
      }
    },
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('index.html is missing <div id="root">.');
}
const root = createRoot(rootElement);

try {
  await startMockApi();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  // Without its mock API, every page would fail in confusing ways, so show one
  // clear explanation instead.
  console.error('The mock API could not start.', error);
  root.render(
    <StrictMode>
      <MockApiStartError />
    </StrictMode>,
  );
}
