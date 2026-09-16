import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import { isWorthRetrying } from '@/lib/problem';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry a failed request once, but only when trying again can help: the
      // API could not be reached, or it had a server error. A 400 or 404 would
      // only fail again, so those show their error straight away.
      retry: (failureCount, error) => failureCount < 1 && isWorthRetrying(error),
      // Treat loaded data as fresh for 30 seconds to avoid needless refetching.
      staleTime: 30_000,
    },
  },
});

/** The whole dashboard: data fetching (React Query) around the pages (React Router). */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
