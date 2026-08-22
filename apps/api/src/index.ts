import dotenv from 'dotenv';
import { buildServer } from './server.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

const port = Number(process.env.PORT ?? 4000);
const server = await buildServer();
await server.listen({ port, host: '0.0.0.0' });
