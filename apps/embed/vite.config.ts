/**
 * Builds the call button as a single self-contained IIFE (`dist/call-button.js`, no
 * module loader needed) so any website can load it with a plain `<script>` tag. The API
 * serves `dist/` at `/embed/`. `vite` (dev) serves the demo page `index.html` on 3001.
 */
import { defineConfig } from 'vite';

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
