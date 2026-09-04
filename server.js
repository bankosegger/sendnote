require('dotenv').config({ quiet: true });

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { put, get, del } = require('@vercel/blob');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_CIPHERTEXT_B64_LEN = 200_000; // ~150KB plaintext ceiling per note
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ciphertext is ~plaintext size, so this is the effective image size cap
const IV_B64_LEN = 16; // base64 length of the client's 12-byte AES-GCM IV (public/crypto.js)
const SALT_B64_LEN = 24; // base64 length of the client's 16-byte PBKDF2 salt (public/crypto.js)
const TTL_OPTIONS = new Set(['burn', '1h', '1d', '7d']);
const NOTE_ID_RE = /^[A-Za-z0-9_-]{22}$/; // shape of crypto.randomBytes(16).toString('base64url')
const ALLOWED_NOTE_BODY_KEYS = new Set(['ciphertext', 'iv', 'ttl', 'password', 'image']);
// The store is private, so the pathname itself (not a fetchable URL) is the
// only thing that moves between client and server; every image download is
// relayed through this server, which alone holds the blob read/write token.
// The burn/ttl prefix is fixed by us at upload time (see POST /api/images)
// so GET /api/images can decide whether to delete-after-serving without
// trusting anything the client says on the download request itself.
const IMAGE_PATHNAME_RE = /^img\/(burn|ttl)\/[A-Za-z0-9_-]{1,260}$/;

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
        imgSrc: ["'self'", 'blob:'],
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

const imageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.IMAGE_RATE_LIMIT || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many images uploaded from this address. Try again later.' },
});

// The client encrypts the image bytes first (reusing the note's own AES key
// under a fresh IV — see public/crypto.js) and uploads the raw ciphertext
// here, ahead of note creation, so it never has to pass through our JSON
// body parser or its 1mb limit. If the note is never actually created, the
// 1-hour cleanup scheduled below still reclaims it (see store.js).
app.post(
  '/api/images',
  imageLimiter,
  express.raw({ type: 'application/octet-stream', limit: MAX_IMAGE_BYTES + 1024 }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'image data required' });
      }
      if (req.body.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'image too large' });
      }

      const burn = req.query.burn === '1';
      const pathname = `img/${burn ? 'burn' : 'ttl'}/${crypto.randomBytes(16).toString('hex')}`;
      const blob = await put(pathname, req.body, {
        access: 'private',
        addRandomSuffix: true,
        contentType: 'application/octet-stream',
      });

      await store.scheduleImageCleanup(blob.pathname, 3600);

      res.json({ pathname: blob.pathname });
    } catch (err) {
      next(err);
    }
  }
);

// The store is private, so the client can't fetch a blob URL directly — this
// relays the ciphertext bytes through the server, which holds the token.
// For a burn-mode image (pathname prefix fixed at upload time, see above),
// this is also the one and only read: we delete it from the store right
// after buffering it, before responding, so a second request 404s the same
// way a second read of the note text already does.
app.get('/api/images', readLimiter, async (req, res, next) => {
  try {
    const pathname = req.query.p;
    if (typeof pathname !== 'string' || !IMAGE_PATHNAME_RE.test(pathname)) {
      return res.status(404).json({ error: 'not found' });
    }

    const blob = await get(pathname, { access: 'private' });
    if (!blob || blob.statusCode !== 200) {
      return res.status(404).json({ error: 'not found' });
    }
    const bytes = Buffer.from(await new Response(blob.stream).arrayBuffer());

    if (pathname.startsWith('img/burn/')) {
      try {
        await del(pathname);
        await store.clearImageCleanup([pathname]);
      } catch (err) {
        console.error('blob cleanup failed', err);
      }
    }

    res.set('Content-Type', 'application/octet-stream').send(bytes);
  } catch (err) {
    next(err);
  }
});

app.post('/api/notes', createLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};

    if (Object.keys(body).some((key) => !ALLOWED_NOTE_BODY_KEYS.has(key))) {
      return res.status(400).json({ error: 'unexpected field in request body' });
    }

    const { ciphertext, iv, ttl, password, image } = body;

    if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
      return res.status(400).json({ error: 'ciphertext and iv are required' });
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_B64_LEN) {
      return res.status(400).json({ error: 'note is empty or too large' });
    }
    // The client always generates a 12-byte AES-GCM IV (crypto.js), which is
    // exactly 16 base64 characters with no padding, so nobody (including A.) 
    // can send Base64-encoded images as IV.
    if (iv.length !== IV_B64_LEN) {
      return res.status(400).json({ error: 'invalid iv' });
    }
    if (!/^[A-Za-z0-9+/]+=*$/.test(ciphertext) || !/^[A-Za-z0-9+/]+$/.test(iv)) {
      return res.status(400).json({ error: 'ciphertext and iv must be base64' });
    }

    // password is never sent — only the non-secret PBKDF2 salt/iterations
    // the browser derived the key with, so a later viewer can re-derive it.
    let passwordMeta;
    if (password !== undefined) {
      const { salt, iterations } = password || {};
      if (
        typeof salt !== 'string' ||
        salt.length !== SALT_B64_LEN ||
        !/^[A-Za-z0-9+/]+=*$/.test(salt) ||
        !Number.isInteger(iterations) ||
        iterations < 100_000 ||
        iterations > 2_000_000
      ) {
        return res.status(400).json({ error: 'invalid password metadata' });
      }
      passwordMeta = { salt, iterations };
    }

    // Just a pointer into blob storage the client already uploaded to via
    // POST /api/images — the server never sees image plaintext here, only
    // where to find the ciphertext it already relayed.
    let imageMeta;
    if (image !== undefined) {
      const { pathname, iv: imageIv } = image || {};
      if (
        typeof pathname !== 'string' ||
        !IMAGE_PATHNAME_RE.test(pathname) ||
        typeof imageIv !== 'string' ||
        imageIv.length !== IV_B64_LEN ||
        !/^[A-Za-z0-9+/]+$/.test(imageIv)
      ) {
        return res.status(400).json({ error: 'invalid image metadata' });
      }
      imageMeta = { pathname, iv: imageIv };
    }

    const mode = TTL_OPTIONS.has(ttl) ? ttl : 'burn';
    const id = crypto.randomBytes(16).toString('base64url');

    await store.createNote(id, { ciphertext, iv, password: passwordMeta, image: imageMeta }, mode);

    res.json({ id });
  } catch (err) {
    next(err);
  }
});

app.get('/api/notes/:id', readLimiter, async (req, res, next) => {
  try {
    if (!NOTE_ID_RE.test(req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    const note = await store.consumeNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'not found' });

    // The image itself isn't deleted here even for a burn note — the client
    // hasn't downloaded it yet at this point, only the note text. Deletion
    // for a burn-mode image happens in GET /api/images instead, right after
    // it's actually served (see the comment there).
    const response = { ciphertext: note.ciphertext, iv: note.iv, burnAfterRead: note.burnAfterRead };
    if (note.password) response.password = note.password;
    if (note.image) response.image = { pathname: note.image.pathname, iv: note.image.iv };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Client-side routing: /n/:id is handled by the SPA.
app.get('/n/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Reclaims images from blob storage whose notes expired (or were burned but
// never read) without ever being explicitly deleted — see the comment on
// IMAGE_CLEANUP_KEY in store.js. Wired to run daily via vercel.json crons.
app.get('/api/cron/cleanup-images', async (req, res, next) => {
  try {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const pathnames = await store.dueImageCleanups();
    const deleted = [];
    for (const pathname of pathnames) {
      try {
        await del(pathname);
        deleted.push(pathname);
      } catch (err) {
        console.error('cron blob delete failed', pathname, err);
      }
    }
    await store.clearImageCleanup(deleted);

    res.json({ deleted: deleted.length });
  } catch (err) {
    next(err);
  }
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
