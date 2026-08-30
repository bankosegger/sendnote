# sendnote

A tiny, self-destructing note sharer. Write a note, it's encrypted right in
your browser (AES-256-GCM), and you get a link back. The server only ever
sees ciphertext — the decryption key lives in the URL fragment, which never
gets sent over the network. Notes live in memory only, so a restart wipes
everything; nothing is written to disk.

## Running it

```
npm install
npm start
```

Then open `http://localhost:3000`.

A few things you can tune with env vars, all optional: `PORT` (default
3000), `MAX_NOTES` (how many notes it'll hold in memory at once before
refusing new ones, default 20000), `CREATE_RATE_LIMIT` / `READ_RATE_LIMIT`
(per-IP limits, default 30 creates/15min and 60 reads/min), and
`TRUST_PROXY=1` if you're putting it behind a reverse proxy.

## Putting it on a real server

The one non-negotiable: **run it behind something that terminates HTTPS**
(Caddy is the easiest — a couple lines and it handles certs for you).
The app itself only speaks plain HTTP, so without TLS in front of it, the
ciphertext is being sent over an unencrypted connection, which defeats a
chunk of the point.

Beyond that, set `TRUST_PROXY=1` so rate limiting sees real client IPs
through the proxy, and run it under something that restarts it if it dies
(`systemd`, `pm2`, a container with `restart: always`) — there's a
`/healthz` endpoint for that. Just know that a restart drops any unread
notes, since none of this is persisted on purpose.

It already has reasonable defenses baked in: rate limits, a cap on total
notes so it can't be flooded into running out of memory, locked-down
security headers/CSP, and note text is only ever rendered as plain text (no
`innerHTML`), so there's no script-injection angle through note content.
What it doesn't have is any notion of accounts, moderation, or abuse
reporting — it's a pastebin-shaped tool, so if you put it in front of the
public internet, you're the one responsible for what people send through
it.
