const express = require('express');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory only: nothing ever touches disk, and everything vanishes on
// restart. The server only ever sees ciphertext + an IV — the AES key
// lives in the URL fragment, which browsers never transmit to servers.
const notes = new Map();

const MAX_CIPHERTEXT_B64_LEN = 200_000; // ~150KB plaintext ceiling per note
const MAX_NOTES = Number(process.env.MAX_NOTES || 20_000); // memory-exhaustion guard
const TTL_OPTIONS = new Set(['burn', '1h', '1d', '7d']);
const TTL_MS = { '1h': 3_600_000, '1d': 86_400_000, '7d': 604_800_000 };

function sweepExpired() {
  const now = Date.now();
  for (const [id, note] of notes) {
    if (note.expiresAt && note.expiresAt <= now) notes.delete(id);
  }
}
setInterval(sweepExpired, 60_000).unref();

// Set TRUST_PROXY=1 when running behind a reverse proxy (nginx, Caddy, etc.)
// so req.ip / rate limiting see the real client IP from X-Forwarded-For
// instead of the proxy's own address.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CREATE_RATE_LIMIT || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many notes created from this address. Try again later.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.READ_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

app.post('/api/notes', createLimiter, (req, res) => {
  const { ciphertext, iv, ttl } = req.body || {};

  if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
    return res.status(400).json({ error: 'ciphertext and iv are required' });
  }
  if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_B64_LEN) {
    return res.status(400).json({ error: 'note is empty or too large' });
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(ciphertext) || !/^[A-Za-z0-9+/]+=*$/.test(iv)) {
    return res.status(400).json({ error: 'ciphertext and iv must be base64' });
  }
  if (notes.size >= MAX_NOTES) {
    return res.status(503).json({ error: 'Server is at capacity. Try again later.' });
  }

  const mode = TTL_OPTIONS.has(ttl) ? ttl : 'burn';

  const id = crypto.randomBytes(16).toString('base64url');
  notes.set(id, {
    ciphertext,
    iv,
    burnAfterRead: mode === 'burn',
    expiresAt: mode === 'burn' ? Date.now() + 604_800_000 : Date.now() + TTL_MS[mode],
  });

  res.json({ id });
});

app.get('/api/notes/:id', readLimiter, (req, res) => {
  const note = notes.get(req.params.id);

  if (!note || (note.expiresAt && note.expiresAt <= Date.now())) {
    notes.delete(req.params.id);
    return res.status(404).json({ error: 'not found' });
  }

  if (note.burnAfterRead) notes.delete(req.params.id);

  res.json({ ciphertext: note.ciphertext, iv: note.iv, burnAfterRead: note.burnAfterRead });
});

// Client-side routing: /n/:id is handled by the SPA.
app.get('/n/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Last-resort error handler: never leak stack traces (malformed JSON bodies
// land here as SyntaxError from the express.json parser).
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'malformed request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`sendnote listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
