# sendnote

Self-destructing, end-to-end encrypted notes. Notes (and optional image
attachments) are encrypted in the browser with AES-256-GCM; the key lives in
the URL fragment and never reaches the server. Ciphertext is stored in Redis
(notes, with a TTL matching the chosen expiry) and Vercel Blob (images).

## Run locally

Needs a Redis database (Upstash free tier works, REST-based). Copy
`.env.example` to `.env` and fill in its credentials. Images additionally
need `BLOB_READ_WRITE_TOKEN`; without it, everything else still works.

```
npm install
npm start   # http://localhost:3000
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `CREATE_RATE_LIMIT` | 30 / 15 min | Per-IP note creations |
| `IMAGE_RATE_LIMIT` | 20 / 15 min | Per-IP image uploads |
| `READ_RATE_LIMIT` | 60 / min | Per-IP reads |
| `MAX_RESERVED_IMAGE_BYTES` | 256 MiB | Global image storage cap; keep below your Blob limit |
| `CRON_SECRET` | — | Authenticates `/api/cron/cleanup-images` |
| `TRUST_PROXY` | — | Set `1` behind a reverse proxy so rate limits see real IPs |

## CLI

`bin/sendnote.js`: zero-dependency (Node 20+), shares `public/crypto.js` with
the browser, so links are interchangeable. Install with `npm link`.

```
sendnote "the wifi password is hunter2"        # prints the link
cat secrets.env | sendnote send --ttl 1h       # stdin; burn/1h/1d/7d
sendnote send -p -i photo.jpg "see attached"   # password + image
sendnote read "https://your-host/n/AbC...#key" # prints note, saves image
```

Server: `--server <url>` or `SENDNOTE_URL` (default `http://localhost:3000`);
`read` uses the link's host. Password: no-echo prompt or `SENDNOTE_PASSWORD`.
Only the link/note goes to stdout. See `sendnote --help`.

## Deploy

**Vercel:** add a Redis database (Upstash for Redis / Vercel KV) and a Blob
store under Storage; credentials are injected automatically. Set
`CRON_SECRET`, then push. `vercel.json` runs `server.js` as one function and
schedules a daily cron deleting blobs of expired notes. Use
`vercel env pull .env` for local dev. Rate-limit counters are per-instance
memory, so on Vercel they're a soft deterrent, not a global cap.

**Elsewhere (any Node host):** set `KV_REST_API_URL` / `KV_REST_API_TOKEN`
(or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`), run `npm start`
under systemd/pm2/a container (health check: `/healthz`), and terminate HTTPS
in front (e.g. Caddy). Set `TRUST_PROXY=1`. Rate limits are global and
reliable on a single process.

## Scope

Included: rate limits, strict security headers/CSP, note text rendered as
plain text only (no `innerHTML`). Not included: accounts, moderation, abuse
reporting. If public, you're responsible for what gets sent through it.
