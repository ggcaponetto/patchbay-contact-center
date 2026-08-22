/**
 * Process entrypoint of the API (`npm run dev:api` / `node src/index.ts`): loads
 * `.env.local` (the one in `apps/api`, then the repo root) and runs the boot sequence in
 * `boot.ts`. Nothing else lives here on purpose, so the wiring stays testable.
 *
 * @see apps/api/README.md
 * @packageDocumentation
 */
import dotenv from 'dotenv';
import { start } from './boot.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });
await start();
