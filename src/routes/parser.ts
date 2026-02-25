import { Hono } from 'hono';
import { OlxApiClient, ParseFields } from '../scrapers/olx.api';

function parseProxy(raw: string, protocol: string): string {
  if (raw.startsWith('http') || raw.startsWith('socks')) return raw;

  if (raw.includes('@')) {
    return `${protocol}://${raw}`;
  }

  const parts = raw.split(':');
  if (parts.length === 4) {
    return `${protocol}://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 2) {
    return `${protocol}://${parts[0]}:${parts[1]}`;
  }
  return `${protocol}://${raw}`;
}

function loadProxies(): string[] {
  const raw = process.env.PROXIES || '';
  if (!raw) return [];
  const protocol = process.env.PROXY_TYPE || 'socks5';
  const proxies = raw.split(',').map(p => p.trim()).filter(Boolean).map(p => parseProxy(p, protocol));
  proxies.forEach((p, i) => console.log(`[olx] proxy ${i}: ${p.replace(/\/\/.*@/, '//***@')}`));
  return proxies;
}

const olxApi = new OlxApiClient({
  proxies: loadProxies(),
  minDelay: Number(process.env.MIN_DELAY) || 1500,
  maxDelay: Number(process.env.MAX_DELAY) || 3000,
  debug: process.env.DEBUG === 'true',
});

const VALID_FIELDS = ['title', 'price', 'phones', 'location', 'description', 'photos'];

export const parserRoutes = new Hono();

parserRoutes.post('/parse', async (c) => {
  try {
    const body = await c.req.json();
    const { url, offerId, fields, limit, page, domain } = body;

    if (!url && !offerId) {
      return c.json({
        success: false,
        error: 'Required: "url" or "offerId"',
        usage: {
          single: { offerId: '722096579', fields: ['title', 'phones'] },
          category: { url: 'https://www.olx.ua/uk/rabota/.../', limit: 10, page: 1, fields: ['title', 'price'] },
          fields: VALID_FIELDS,
        }
      }, 400);
    }

    const validFields: ParseFields | undefined = fields?.length
      ? fields.filter((f: string) => VALID_FIELDS.includes(f))
      : undefined;

    const results = await olxApi.parse({
      url,
      offerId,
      fields: validFields,
      limit: limit ? Number(limit) : undefined,
      page: page ? Number(page) : undefined,
      domain,
    });

    return c.json({
      success: true,
      count: results.length,
      data: results.length === 1 ? results[0] : results,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});
