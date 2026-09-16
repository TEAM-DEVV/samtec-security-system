import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

/** Renders a component inside the same providers the real app uses. */
export function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    // No automatic retries in tests, so error states appear straight away.
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
