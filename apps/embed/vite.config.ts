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
