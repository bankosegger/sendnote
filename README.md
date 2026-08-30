# sendnote

A tiny, self-destructing note sharer. Write a note, it's encrypted right in
your browser (AES-256-GCM), and you get a link back. The server only ever
sees ciphertext — the decryption key lives in the URL fragment, which never
gets sent over the network. Notes are stored in Redis with a TTL matching
whatever expiry you picked, so nothing lingers past its own expiration and
nothing is ever written in plaintext anywhere.

## Running it locally

You need a Redis database — Upstash's free tier works well and is REST-based,
so there's nothing to install locally. Create one, copy `.env.example` to
`.env`, and fill in the URL/token it gives you. Then:

```
npm install
npm start
```

Open `http://localhost:3000`.

Other optional env vars: `PORT` (default 3000), `CREATE_RATE_LIMIT` /
`READ_RATE_LIMIT` (per-IP limits, default 30 creates/15min and 60 reads/min),
and `TRUST_PROXY=1` if you're putting it behind a reverse proxy.

## Deploying to Vercel

1. In your Vercel project, go to Storage → add a Redis database (Marketplace
   → Upstash for Redis, or Vercel KV if that's still offered on your
   account). Vercel wires the credentials into your project's env vars
   automatically — no manual copying needed in production.
2. Push. `vercel.json` in this repo tells Vercel to run the whole app as one
   function (`server.js`), with `public/` bundled alongside it.
3. For local dev against the same database, run `vercel env pull .env` (or
   just copy the values from the dashboard into `.env` yourself).

Note on rate limiting there: the limiter's counters live in each function
instance's memory, and Vercel can spin up multiple instances or recycle them
between requests — so on Vercel the limits act as a soft deterrent rather
than a hard global cap. Fine for keeping casual abuse down; not a guarantee.

## Deploying elsewhere

Works the same way anywhere that runs Node: point `KV_REST_API_URL` /
`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`)
at your Redis instance and run `npm start`. Put it behind something that
terminates HTTPS (Caddy is the easiest — a couple lines and it handles certs
for you); without TLS in front, the ciphertext travels over an unencrypted
connection, which defeats a chunk of the point. Run it under `systemd`,
`pm2`, or a container with `restart: always` — there's a `/healthz` endpoint
for that — and set `TRUST_PROXY=1` if it's behind a reverse proxy, so rate
limiting sees real client IPs. On a single long-running process like this,
the rate limiter's counters are actually global and reliable (unlike the
Vercel case above).

## What's already handled, what isn't

Baked in: rate limits, locked-down security headers/CSP, and note text is
only ever rendered as plain text (no `innerHTML`), so there's no
script-injection angle through note content. What it doesn't have is any
notion of accounts, moderation, or abuse reporting — it's a pastebin-shaped
tool, so if you put it in front of the public internet, you're the one
responsible for what people send through it.
