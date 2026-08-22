/**
 * Browser entry point of the agent desk (referenced from `index.html`).
 *
 * Sets up the providers every page relies on and mounts {@link App}:
 * - MUI theme with a dark color scheme available (follows the OS preference) and
 *   `CssBaseline` for consistent defaults.
 * - A TanStack Query client: one retry, data considered fresh for 5 s. Pages re-fetch by
 *   changing query keys (see `callsVersion` in `lib/store.ts`) rather than polling.
 */
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const theme = createTheme({ colorSchemes: { dark: true } });
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
