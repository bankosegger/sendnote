require('dotenv').config({ quiet: true });

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_CIPHERTEXT_B64_LEN = 200_000; // ~150KB plaintext ceiling per note
const TTL_OPTIONS = new Set(['burn', '1h', '1d', '7d']);

// Set TRUST_PROXY=1 when running behind a reverse proxy (nginx, Caddy, etc.)
// so req.ip / rate limiting see the real client IP from X-Forwarded-For.
// Vercel's own edge network already sets this correctly for you.
if (process.env.TRUST_PROXY === '1' || process.env.VERCEL) {
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

// Note: these limits are per function instance. On a serverless platform
// like Vercel that spins up multiple/short-lived instances, they act as a
// soft deterrent rather than a hard global cap — see README.
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

app.post('/api/notes', createLimiter, async (req, res, next) => {
  try {
    const { ciphertext, iv, ttl, password } = req.body || {};

    if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
      return res.status(400).json({ error: 'ciphertext and iv are required' });
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_B64_LEN) {
      return res.status(400).json({ error: 'note is empty or too large' });
    }
    if (!/^[A-Za-z0-9+/]+=*$/.test(ciphertext) || !/^[A-Za-z0-9+/]+=*$/.test(iv)) {
      return res.status(400).json({ error: 'ciphertext and iv must be base64' });
    }

    // password is never sent — only the non-secret PBKDF2 salt/iterations
    // the browser derived the key with, so a later viewer can re-derive it.
    let passwordMeta;
    if (password !== undefined) {
      const { salt, iterations } = password || {};
      if (
        typeof salt !== 'string' ||
        salt.length === 0 ||
        salt.length > 64 ||
        !/^[A-Za-z0-9+/]+=*$/.test(salt) ||
        !Number.isInteger(iterations) ||
        iterations < 100_000 ||
        iterations > 2_000_000
      ) {
        return res.status(400).json({ error: 'invalid password metadata' });
      }
      passwordMeta = { salt, iterations };
    }

    const mode = TTL_OPTIONS.has(ttl) ? ttl : 'burn';
    const id = crypto.randomBytes(16).toString('base64url');

    await store.createNote(id, { ciphertext, iv, password: passwordMeta }, mode);

    res.json({ id });
  } catch (err) {
    next(err);
  }
});

app.get('/api/notes/:id', readLimiter, async (req, res, next) => {
  try {
    const note = await store.consumeNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'not found' });
    res.json(note);
  } catch (err) {
    next(err);
  }
});

// Client-side routing: /n/:id is handled by the SPA.
app.get('/n/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Last-resort error handler: never leak stack traces (malformed JSON bodies
// land here as SyntaxError from the express.json parser; Redis failures land
// here too).
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'malformed request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

// Vercel's @vercel/node builder imports this file and calls the exported
// app directly as a request handler — it must not also try to bind a port.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`sendnote listening on http://localhost:${PORT}`);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

module.exports = app;
