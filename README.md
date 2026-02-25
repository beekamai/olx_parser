# OLX Parser API

Lightweight REST API for parsing OLX listings across multiple regions (`.ua`, `.ro`, `.pl`, etc.).  
No browser required — works via pure HTTP requests to OLX internal APIs.

## Features

- **Multi-region** — auto-detects domain from URL (`olx.ua`, `olx.ro`, `olx.pl`, etc.)
- **Proxy rotation** — SOCKS5 / HTTP with per-proxy delays and retry logic
- **Parallel workers** — one worker per proxy, each with independent rate limiting
- **Pagination** — `page` parameter + auto-pagination when `limit` exceeds page size
- **Field selection** — request only the data you need
- **Rate-limit bypass** — auto-retry with exponential backoff on suspicious activity blocks
- **Debug mode** — verbose logging of proxy usage, responses, and retry decisions

## Quick Start

```bash
git clone https://github.com/beekamai/olx_parser.git
cd olx-parser
npm install
cp .env.example .env
npm run dev
```

Server starts at `http://localhost:3000`.

## API

### `POST /api/parse`

#### Request Parameters

| Parameter | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `url`     | string   | *        | OLX category or search URL |
| `offerId` | string   | *        | Numeric offer ID (alternative to `url`) |
| `fields`  | string[] | no       | Filter response fields |
| `limit`   | number   | no       | Max ads to return |
| `page`    | number   | no       | Start page number |
| `domain`  | string   | no       | Override domain (e.g. `www.olx.ro`) |

\* Either `url` or `offerId` is required.

#### Available Fields

`title`, `price`, `phones`, `location`, `description`, `photos`

> If `fields` is omitted — all data is returned.  
> If only `title`/`price`/`location` are requested — data is extracted from HTML instantly, zero API calls.  
> If `phones`/`description`/`photos` are included — requires REST API calls with rate limiting.

---

### Examples

#### Category — titles & prices (instant, no API calls)

**Request:**
```json
POST /api/parse
{
  "url": "https://www.olx.ro/auto-masini-moto-ambarcatiuni/autoturisme/",
  "fields": ["title", "price"],
  "limit": 3
}
```

**Response:**
```json
{
  "success": true,
  "count": 3,
  "data": [
    {
      "id": "298917820",
      "url": "https://www.olx.ro/d/oferta/...",
      "title": "Volkswagen Golf 7 2017",
      "price": "10500 EUR"
    },
    {
      "id": "290637042",
      "url": "https://www.olx.ro/d/oferta/...",
      "title": "Skoda Octavia 2019",
      "price": "14200 EUR"
    },
    {
      "id": "294724526",
      "url": "https://www.olx.ro/d/oferta/...",
      "title": "Dacia Logan 2021",
      "price": "8900 EUR"
    }
  ]
}
```

#### Category — with phone numbers

**Request:**
```json
POST /api/parse
{
  "url": "https://www.olx.ua/uk/rabota/marketing-reklama-dizayn/",
  "fields": ["title", "phones"],
  "limit": 2,
  "page": 2
}
```

**Response:**
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "id": "915276287",
      "url": "https://www.olx.ua/uk/obyavlenie/...",
      "title": "Менеджер з реклами",
      "phones": ["073 036 2154"]
    },
    {
      "id": "911664006",
      "url": "https://www.olx.ua/uk/obyavlenie/...",
      "title": "SMM-спеціаліст",
      "phones": ["067 123 4567"]
    }
  ]
}
```

#### Single offer — all data

**Request:**
```json
POST /api/parse
{
  "offerId": "298917820"
}
```

**Response:**
```json
{
  "success": true,
  "count": 1,
  "data": {
    "id": "298917820",
    "title": "Volkswagen Golf 7 2017",
    "description": "<p>Full description...</p>",
    "price": "10500 EUR",
    "location": {
      "city": "București",
      "district": "Sector 3",
      "region": "București"
    },
    "phones": ["073 036 2154"],
    "contact": {
      "name": "Andrei",
      "negotiation": false
    },
    "url": "https://www.olx.ro/d/oferta/...",
    "photos": [
      "https://ireland.apollo.olxcdn.com/v1/files/..."
    ]
  }
}
```

#### Single offer — different region

**Request:**
```json
POST /api/parse
{
  "offerId": "722096579",
  "domain": "www.olx.ro"
}
```

#### Error response

```json
{
  "success": false,
  "error": "Required: \"url\" or \"offerId\""
}
```

---

## Configuration

All settings are configured via `.env` file (see `.env.example`).

| Variable     | Default  | Description |
|-------------|----------|-------------|
| `PROXIES`   | —        | Comma-separated proxy list |
| `PROXY_TYPE`| `socks5` | Default protocol when not specified in proxy |
| `MIN_DELAY` | `1500`   | Min delay between API requests (ms) |
| `MAX_DELAY` | `3000`   | Max delay between API requests (ms) |
| `PORT`      | `3000`   | Server port |
| `DEBUG`     | `false`  | Verbose logging (`true` to enable) |

### Proxy Formats

All formats are supported:

```env
# ip:port:user:pass
PROXIES=1.2.3.4:9000:myuser:mypass

# user:pass@ip:port
PROXIES=myuser:mypass@1.2.3.4:9000

# Full URL
PROXIES=socks5://myuser:mypass@1.2.3.4:9000

# Multiple (comma-separated)
PROXIES=1.2.3.4:9000:user1:pass1,5.6.7.8:8080:user2:pass2

# Without auth
PROXIES=1.2.3.4:9000
```

---

## How It Works

### Data Flow

1. **Category URL** → fetches HTML page → extracts embedded JSON with ad data (title, price, location, contact)
2. **Phone numbers** → calls `GET /api/v1/offers/{id}/limited-phones/` per ad
3. **Full ad data** → calls `GET /api/v1/offers/{id}/` per ad

### Performance

| Request Type | Speed | API Calls |
|---|---|---|
| `fields: ["title", "price", "location"]` | Instant | 0 (HTML only) |
| `fields: ["phones"]` | ~2-3s per ad | 1 per ad |
| All fields | ~3-5s per ad | 2 per ad |

### Parallelism

- **No proxies** → sequential processing, one request at a time
- **N proxies** → N parallel workers, each with its own proxy and independent delay
- Example: 5 proxies = 5x faster phone number collection

### Pagination

- `page: 2` → starts from page 2
- `limit: 100` with 50 ads per page → automatically fetches pages until limit is reached
- If `page` is already in the URL, it gets replaced

### Rate-Limit Handling

When OLX returns a "suspicious activity" block (400/403/429):
1. Waits 3-5 seconds (+ random jitter)
2. Switches to a different proxy
3. Retries the request
4. Exponential backoff: 3s → 6s → 12s
5. Max 3 retries per request

---

## Known Limitations

### Datacenter Proxies & CloudFront

OLX uses CloudFront (AWS CDN) which blocks most datacenter proxy IPs with a 403 error. This means:

- **Datacenter proxies** (most cheap SOCKS5/HTTP proxies) → blocked by CloudFront before reaching OLX
- **Residential proxies** (BrightData, IPRoyal, Smartproxy) → work correctly
- **No proxy** → works for moderate usage until rate-limited

**Recommendation:** For production use with phone number scraping, use residential proxies. For basic data (title, price, location) — proxies are not needed at all.

### Debug Mode

Enable `DEBUG=true` in `.env` to see detailed logs:

```
[olx:debug] → https://www.olx.ro/api/v1/offers/298917820/limited-phones/
[olx:debug]   proxy: socks5://***@1.2.3.4:9000
[olx:debug]   ← 200 OK
```

This helps diagnose proxy issues, rate limits, and CloudFront blocks.

---

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: [Hono](https://hono.dev/) + @hono/node-server
- **HTTP Client**: [node-fetch](https://github.com/node-fetch/node-fetch) (proxy support)
- **Proxy**: socks-proxy-agent, https-proxy-agent
- **Dev**: tsx (TypeScript execution)

## License

MIT
