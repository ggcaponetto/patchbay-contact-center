/**
 * Vite config for the agent desk. `/api` (REST + websocket) is proxied to the API so
 * auth cookies stay first-party; set `API_PORT` when the API does not listen on 4000.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.API_PORT ?? '4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 3000),
    proxy: { '/api': { target: `http://localhost:${apiPort}`, ws: true } },
  },
});
