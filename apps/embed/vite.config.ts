/**
 * Builds the call button as a single self-contained IIFE (`dist/call-button.js`, no
 * module loader needed) so any website can load it with a plain `<script>` tag. The API
 * serves `dist/` at `/embed/`. `vite` (dev) serves the demo page `index.html` on 3001.
 */
import dotenv from 'dotenv';
import { defineConfig } from 'vite';

// The demo page (index.html) reads %VITE_API_ORIGIN% so it points at the API port
// configured in the repo-root .env.local (API_PORT, default 4000).
dotenv.config({ path: ['.env.local', '../../.env.local'], quiet: true });
process.env.VITE_API_ORIGIN ??= `http://localhost:${process.env.API_PORT ?? '4000'}`;

export default defineConfig({
  build: {
    lib: {
      entry: 'src/call-button.ts',
      name: 'CcCallButton',
      formats: ['iife'],
      fileName: () => 'call-button.js',
    },
  },
  server: { port: 3001 },
});
