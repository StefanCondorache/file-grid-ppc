import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isSessionEnding, notifyUnauthenticated } from '@/lib/auth/session-end';
import { ApiError } from './errors';

const onError = (error: unknown) => {
  if (isSessionEnding(error)) notifyUnauthenticated(error);
};

/** Server state defaults (ADR-0009). Every 401 from any query or mutation ends the session (SR-19). */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
