import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

interface RenderOptions {
  /** The web address the test starts at. Defaults to the home page. */
  route?: string;
}

/** Renders a component inside the same providers the real app uses. */
export function renderWithProviders(ui: ReactElement, { route = '/' }: RenderOptions = {}) {
  const queryClient = new QueryClient({
    // No automatic retries in tests, so error states appear straight away.
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
