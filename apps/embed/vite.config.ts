/**
 * Builds the call button as a single self-contained IIFE (`dist/call-button.js`, no
 * module loader needed) so any website can load it with a plain `<script>` tag. React
 * and `livekit-client` are bundled in. The API serves `dist/` at `/embed/`. `vite`
 * (dev) serves the demo page `index.html` on 3001 and proxies `/api` to the API, so the
 * button calls its own origin and only the demo page's port has to be reachable (a
 * Codespace, a tunnel); set `API_PORT` when the API does not listen on 4000.
 */
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { defineConfig } from 'vite';

// The repo-root .env.local is the single source of truth for ports (see .env.example).
dotenv.config({ path: ['.env.local', '../../.env.local'], quiet: true });
const apiPort = process.env.API_PORT ?? '4000';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // React reads `process.env.NODE_ENV`; a browser script has no `process`, so inline it.
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
  },
  build: {
    lib: {
      entry: 'src/call-button.ts',
      name: 'CcCallButton',
      formats: ['iife'],
      fileName: () => 'call-button.js',
    },
  },
  server: {
    port: 3001,
    proxy: { '/api': { target: `http://localhost:${apiPort}` } },
  },
}));
