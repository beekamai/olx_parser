import { serve } from '@hono/node-server';
import { app } from './app';

const PORT = Number(process.env.PORT) || 3000;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`🦊 OLX Parser API is running at http://localhost:${info.port}`);
});
