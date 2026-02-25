import { Hono } from 'hono';
import { parserRoutes } from './routes/parser';

export const app = new Hono();

app.route('/api', parserRoutes);

app.onError((err, c) => {
  return c.json({
    success: false,
    error: err.message
  }, 500);
});
