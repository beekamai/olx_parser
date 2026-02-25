import nodeFetch from 'node-fetch';
import { OlxAdData } from '../types/olx';

function apiBase(domain: string): string {
  return `https://${domain}/api/v1`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'www.olx.ua';
  }
}

function buildPageUrl(baseUrl: string, page: number): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('page', String(page));
  return parsed.toString();
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

function sleep(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise(r => setTimeout(r, ms));
}

interface ProxyConfig { url: string }

export type ParseFields = ('title' | 'price' | 'phones' | 'location' | 'description' | 'photos')[];

interface ParseOptions {
  url?: string;
  offerId?: string;
  fields?: ParseFields;
  limit?: number;
  page?: number;
  domain?: string;
}

export class OlxApiClient {
  private proxies: ProxyConfig[] = [];
  private proxyIndex = 0;
  private minDelay: number;
  private maxDelay: number;
  private debug: boolean;

  constructor(options?: { proxies?: string[]; minDelay?: number; maxDelay?: number; debug?: boolean }) {
    if (options?.proxies?.length) {
      this.proxies = options.proxies.map(p => ({ url: p }));
      console.log(`[olx] ${this.proxies.length} proxies loaded`);
    }
    this.minDelay = options?.minDelay ?? 1500;
    this.maxDelay = options?.maxDelay ?? 3000;
    this.debug = options?.debug ?? false;
    if (this.debug) console.log('[olx] DEBUG mode enabled');
  }

  private log(...args: any[]) {
    if (this.debug) console.log('[olx:debug]', ...args);
  }

  private getHeaders(accept = 'application/json'): Record<string, string> {
    return {
      'User-Agent': randomUA(),
      'Accept': accept,
      'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.5',
      'Referer': 'https://www.olx.ua/',
      'Origin': 'https://www.olx.ua',
    };
  }

  private getNextProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.proxyIndex % this.proxies.length]!;
    this.proxyIndex++;
    return proxy;
  }

  private getProxyByIndex(index: number): ProxyConfig | null {
    if (this.proxies.length === 0) return null;
    return this.proxies[index % this.proxies.length]!;
  }

  private async createAgent(proxyUrl: string): Promise<any> {
    if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks://')) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      return new SocksProxyAgent(proxyUrl);
    }
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  }

  private isRateLimitBody(body: string): boolean {
    const lower = body.toLowerCase();
    return lower.includes('activitate suspect')
      || lower.includes('підозрілу активність')
      || lower.includes('подозрительн')
      || lower.includes('suspicious activit')
      || lower.includes('the request could not be satisfied')
      || lower.includes('cloudfront');
  }

  private async doFetch(url: string, proxyIdx: number | null, options: RequestInit = {}): Promise<Response> {
    const headers = { ...this.getHeaders(), ...options.headers as Record<string, string> };
    let proxy: ProxyConfig | null = null;

    if (proxyIdx !== null) {
      proxy = this.getProxyByIndex(proxyIdx);
    } else if (this.proxies.length > 0) {
      proxy = this.getNextProxy();
    }

    const proxyLabel = proxy ? proxy.url.replace(/\/\/.*@/, '//***@') : 'direct';
    this.log(`→ ${url}`);
    this.log(`  proxy: ${proxyLabel}`);

    if (proxy) {
      const agent = await this.createAgent(proxy.url);
      const res = await nodeFetch(url, { ...options as any, headers, agent });
      this.log(`  ← ${res.status} ${res.statusText}`);
      return res as unknown as Response;
    }

    const res = await fetch(url, { ...options, headers });
    this.log(`  ← ${res.status} ${res.statusText}`);
    return res;
  }

  private async fetchWithRetry(url: string, proxyIdx: number | null = null, options: RequestInit = {}): Promise<Response> {
    const maxRetries = 3;
    let backoff = 3000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const currentProxy = proxyIdx !== null
        ? proxyIdx
        : (this.proxies.length > 0 ? (this.proxyIndex - 1) : null);

      const res = await this.doFetch(url, attempt > 0 && this.proxies.length > 1
        ? (currentProxy !== null ? (currentProxy + attempt) % this.proxies.length : null)
        : currentProxy, options);

      if (res.status === 429) {
        this.log(`  ⚠ 429 Too Many Requests`);
        if (attempt === maxRetries) return res;
      } else if (res.status === 400 || res.status === 403) {
        const body = await res.text();
        this.log(`  ⚠ ${res.status} body: ${body.substring(0, 300)}`);
        if (!this.isRateLimitBody(body)) {
          this.log(`  ✗ not rate-limit, skipping retry`);
          return new Response(body, { status: res.status, headers: res.headers }) as any;
        }
        this.log(`  ⚠ rate-limit detected in body`);
        if (attempt === maxRetries) {
          return new Response(body, { status: res.status, headers: res.headers }) as any;
        }
      } else {
        return res;
      }

      const waitMs = backoff + Math.random() * 2000;
      console.warn(`[olx] rate-limited (${res.status}), retry ${attempt + 1}/${maxRetries} in ${Math.round(waitMs)}ms`);
      await sleep(waitMs, waitMs);
      backoff *= 2;
    }

    return this.doFetch(url, proxyIdx, options);
  }

  private async fetchWithProxy(url: string, options: RequestInit = {}): Promise<Response> {
    return this.fetchWithRetry(url, null, options);
  }

  private async fetchWithSpecificProxy(url: string, proxyIndex: number, options: RequestInit = {}): Promise<Response> {
    return this.fetchWithRetry(url, proxyIndex, options);
  }

  async getOffer(offerId: string, domain = 'www.olx.ua'): Promise<any> {
    const res = await this.fetchWithProxy(`${apiBase(domain)}/offers/${offerId}/`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OLX API ${res.status} for offer ${offerId}: ${body.substring(0, 200)}`);
    }
    return ((await res.json()) as any).data;
  }

  async getPhones(offerId: string, domain = 'www.olx.ua'): Promise<string[]> {
    const res = await this.fetchWithProxy(`${apiBase(domain)}/offers/${offerId}/limited-phones/`);
    if (!res.ok) return [];
    return ((await res.json()) as any).data?.phones || [];
  }

  private async getPhonesViaProxy(offerId: string, domain: string, proxyIndex: number): Promise<string[]> {
    const res = await this.fetchWithSpecificProxy(
      `${apiBase(domain)}/offers/${offerId}/limited-phones/`,
      proxyIndex,
    );
    if (!res.ok) return [];
    return ((await res.json()) as any).data?.phones || [];
  }

  async parseById(offerId: string, fields?: ParseFields, domain = 'www.olx.ua'): Promise<Partial<OlxAdData>> {
    console.log(`[olx] parsing offer ${offerId} (${domain})`);
    const needPhones = !fields || fields.includes('phones');
    const needOffer = !fields || fields.some(f => f !== 'phones');

    const [offer, phones] = await Promise.all([
      needOffer ? this.getOffer(offerId, domain) : null,
      needPhones ? this.getPhones(offerId, domain) : Promise.resolve([]),
    ]);

    if (offer) {
      return this.filterFields(this.mapRestOffer(offer, phones), fields);
    }
    return this.filterFields({ id: offerId, phones } as OlxAdData, fields);
  }

  async parse(options: ParseOptions): Promise<Partial<OlxAdData>[]> {
    const { offerId, fields, limit, page } = options;
    let { url } = options;
    const domain = options.domain || (url ? extractDomain(url) : 'www.olx.ua');

    if (offerId) {
      return [await this.parseById(offerId, fields, domain)];
    }

    if (!url) throw new Error('Required: "url" or "offerId"');
    if (!url.includes('olx.')) throw new Error('Only OLX domains supported');

    if (page) url = buildPageUrl(url, page);

    let allAds: OlxAdData[] = [];
    let currentPage = page || 1;
    let currentUrl = url;

    while (true) {
      const pageAds = await this.fetchCategoryPage(currentUrl);
      allAds = allAds.concat(pageAds);

      if (!limit || allAds.length >= limit || pageAds.length === 0) break;

      currentPage++;
      currentUrl = buildPageUrl(url, currentPage);
      await sleep(this.minDelay, this.maxDelay);
    }

    const targetAds = limit ? allAds.slice(0, limit) : allAds;
    const needPhones = !fields || fields.includes('phones');
    const needFullApi = !fields || fields.some(f => ['description', 'photos'].includes(f));

    if (!needPhones && !needFullApi) {
      console.log(`[olx] returning ${targetAds.length} ads from HTML (no API calls needed)`);
      return targetAds.map(ad => this.filterFields(ad, fields));
    }

    return await this.enrichAds(targetAds, fields, domain, needPhones, needFullApi);
  }

  private async enrichAds(
    ads: OlxAdData[],
    fields: ParseFields | undefined,
    domain: string,
    needPhones: boolean,
    needFullApi: boolean,
  ): Promise<Partial<OlxAdData>[]> {
    const concurrency = Math.max(1, this.proxies.length || 1);

    if (concurrency === 1) {
      return this.enrichAdsSequential(ads, fields, domain, needPhones, needFullApi);
    }

    console.log(`[olx] enriching ${ads.length} ads with ${concurrency} parallel workers`);
    return this.enrichAdsParallel(ads, fields, domain, needPhones, needFullApi, concurrency);
  }

  private async enrichAdsSequential(
    ads: OlxAdData[],
    fields: ParseFields | undefined,
    domain: string,
    needPhones: boolean,
    needFullApi: boolean,
  ): Promise<Partial<OlxAdData>[]> {
    const results: Partial<OlxAdData>[] = [];

    for (let i = 0; i < ads.length; i++) {
      const ad = ads[i]!;
      try {
        console.log(`[olx] [${i + 1}/${ads.length}] ${ad.id}`);
        const enriched = await this.enrichSingleAd(ad, fields, domain, needPhones, needFullApi);
        results.push(enriched);
      } catch (e: any) {
        console.warn(`[olx] error ${ad.id}: ${e.message}`);
      }

      if (i < ads.length - 1) await sleep(this.minDelay, this.maxDelay);
    }

    return results;
  }

  private async enrichAdsParallel(
    ads: OlxAdData[],
    fields: ParseFields | undefined,
    domain: string,
    needPhones: boolean,
    needFullApi: boolean,
    concurrency: number,
  ): Promise<Partial<OlxAdData>[]> {
    const results: Partial<OlxAdData>[] = new Array(ads.length);
    const queue = ads.map((ad, i) => ({ ad, index: i }));

    const workers = Array.from({ length: concurrency }, (_, workerIdx) =>
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) break;

          try {
            console.log(`[olx] [worker ${workerIdx}] ${item.ad.id}`);

            if (needPhones && !needFullApi) {
              const phones = await this.getPhonesViaProxy(item.ad.id, domain, workerIdx);
              results[item.index] = this.filterFields({ ...item.ad, phones }, fields);
            } else {
              const offer = await this.getOffer(item.ad.id, domain);
              const phones = needPhones
                ? await this.getPhonesViaProxy(item.ad.id, domain, workerIdx)
                : [];
              results[item.index] = this.filterFields(this.mapRestOffer(offer, phones), fields);
            }
          } catch (e: any) {
            console.warn(`[olx] [worker ${workerIdx}] error ${item.ad.id}: ${e.message}`);
          }

          if (queue.length > 0) await sleep(this.minDelay, this.maxDelay);
        }
      })()
    );

    await Promise.all(workers);
    return results.filter(Boolean);
  }

  private async enrichSingleAd(
    htmlAd: OlxAdData,
    fields: ParseFields | undefined,
    domain: string,
    needPhones: boolean,
    needFullApi: boolean,
  ): Promise<Partial<OlxAdData>> {
    if (needPhones && !needFullApi) {
      const phones = await this.getPhones(htmlAd.id, domain);
      return this.filterFields({ ...htmlAd, phones }, fields);
    }
    return this.parseById(htmlAd.id, fields, domain);
  }

  private async fetchCategoryPage(categoryUrl: string): Promise<OlxAdData[]> {
    console.log(`[olx] fetching: ${categoryUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await this.fetchWithProxy(categoryUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
      });

      if (!res.ok) throw new Error(`OLX returned ${res.status}`);
      const html = await res.text();
      clearTimeout(timeout);

      const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return this.extractAdsFromUnescaped(unescaped);
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error('Category page timeout');
      throw e;
    }
  }

  private extractAdsFromUnescaped(text: string): OlxAdData[] {
    const positions: number[] = [];
    const marker = /"id":(\d{8,9}),"title":"/g;
    let m;
    while ((m = marker.exec(text)) !== null) {
      positions.push(m.index);
    }

    const ads: OlxAdData[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < positions.length; i++) {
      const start = positions[i]!;
      const end = i + 1 < positions.length ? positions[i + 1]! : start + 5000;
      const raw = text.substring(start, end);

      try {
        const jsonStr = '{' + raw.substring(0, raw.lastIndexOf('}') + 1);
        const obj = JSON.parse(jsonStr);
        if (seen.has(String(obj.id))) continue;
        seen.add(String(obj.id));
        ads.push(this.mapHtmlAdObject(obj));
      } catch {
        const ad = this.extractAdByRegex(raw);
        if (ad && !seen.has(ad.id)) {
          seen.add(ad.id);
          ads.push(ad);
        }
      }
    }

    console.log(`[olx] extracted ${ads.length} ads from HTML`);
    return ads;
  }

  private extractAdByRegex(raw: string): OlxAdData | null {
    try {
      const idMatch = raw.match(/"id":(\d+)/);
      if (!idMatch) return null;

      const titleMatch = raw.match(/"title":"(.*?)(?:","description"|","category)/);
      const salaryFrom = raw.match(/"from":(\d+)/);
      const salaryTo = raw.match(/"to":(\d+)/);
      const currCode = raw.match(/"currencyCode":"(\w+)"/);
      const cityMatch = raw.match(/"cityName":"(.*?)"/);
      const regionMatch = raw.match(/"regionName":"(.*?)"/);
      const urlMatch = raw.match(/"url":"(.*?)"/);
      const contactName = raw.match(/"contact":\{.*?"name":"(.*?)"/);

      let price: string | null = null;
      if (salaryFrom && salaryTo) {
        price = `${salaryFrom[1]}-${salaryTo[1]} ${currCode?.[1] || ''}`.trim();
      }

      return {
        id: idMatch[1]!,
        title: titleMatch?.[1] || '',
        description: '',
        price,
        location: {
          city: cityMatch?.[1] || null,
          district: null,
          region: regionMatch?.[1] || null,
        },
        phones: [],
        contact: { name: contactName?.[1] || null, negotiation: false },
        url: urlMatch?.[1]?.replace(/\\u002F/g, '/') || '',
        photos: [],
      };
    } catch {
      return null;
    }
  }

  private mapHtmlAdObject(obj: any): OlxAdData {
    let price: string | null = null;
    if (obj.salary?.from != null) {
      price = `${obj.salary.from}-${obj.salary.to} ${obj.salary.currencyCode || ''}`.trim();
    } else if (obj.price?.displayValue) {
      price = obj.price.displayValue;
    }

    return {
      id: String(obj.id),
      title: obj.title || '',
      description: obj.description || '',
      price,
      location: {
        city: obj.location?.cityName || null,
        district: obj.location?.districtName || null,
        region: obj.location?.regionName || null,
      },
      phones: [],
      contact: { name: obj.contact?.name || null, negotiation: obj.contact?.negotiation || false },
      url: obj.url || '',
      photos: (obj.photos || []).map((p: any) => p?.link || p || ''),
    };
  }

  private filterFields(ad: OlxAdData | Partial<OlxAdData>, fields?: ParseFields): Partial<OlxAdData> {
    if (!fields || fields.length === 0) return ad;
    const result: Partial<OlxAdData> = { id: ad.id, url: ad.url };
    for (const field of fields) {
      if (field in ad) (result as any)[field] = (ad as any)[field];
    }
    return result;
  }

  private mapRestOffer(offer: any, phones: string[]): OlxAdData {
    const priceParam = offer.params?.find((p: any) => p.key === 'price');
    const price = priceParam
      ? `${priceParam.value?.value || ''} ${priceParam.value?.currency || ''}`.trim()
      : null;

    const location = offer.location || {};
    const photos = (offer.photos || []).map((p: any) =>
      p.link?.replace('{width}', '800').replace('{height}', '600') || ''
    );

    return {
      id: String(offer.id),
      title: offer.title || '',
      description: offer.description || '',
      price,
      location: {
        city: location.city?.name || null,
        district: location.district?.name || null,
        region: location.region?.name || null,
      },
      phones,
      contact: { name: offer.contact?.name || null, negotiation: offer.contact?.negotiation || false },
      url: offer.url || '',
      photos,
    };
  }
}
