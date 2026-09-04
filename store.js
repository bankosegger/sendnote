const { Redis } = require('@upstash/redis');

// Works with either naming convention Vercel injects, depending on how the
// Redis database was added to the project (native Vercel KV vs. the
// Upstash Marketplace integration).
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error(
    'Missing Redis credentials. Set KV_REST_API_URL/KV_REST_API_TOKEN ' +
      '(or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) — see .env.example.'
  );
}

const redis = new Redis({ url, token });

const TTL_SECONDS = { burn: 604_800, '1h': 3_600, '1d': 86_400, '7d': 604_800 };

const burnKey = (id) => `burn:${id}`;
const ttlKey = (id) => `ttl:${id}`;

// Blob storage has no built-in expiry, unlike the Redis keys above, so every
// image's pathname is tracked here with a due time matching its note's TTL.
// This is the fallback path — the normal path deletes the blob synchronously
// when a burn note is read (see server.js) — so a note whose image is never
// viewed still doesn't leak storage forever.
const IMAGE_CLEANUP_KEY = 'image-cleanup:pending';

async function scheduleImageCleanup(pathname, ttlSeconds) {
  const dueAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  await redis.zadd(IMAGE_CLEANUP_KEY, { score: dueAt, member: pathname });
}

async function dueImageCleanups(limit = 100) {
  const now = Math.floor(Date.now() / 1000);
  return redis.zrange(IMAGE_CLEANUP_KEY, 0, now, { byScore: true, offset: 0, count: limit });
}

async function clearImageCleanup(pathnames) {
  if (pathnames.length) await redis.zrem(IMAGE_CLEANUP_KEY, ...pathnames);
}

async function createNote(id, { ciphertext, iv, password, image }, mode) {
  const key = mode === 'burn' ? burnKey(id) : ttlKey(id);
  const payload = { ciphertext, iv };
  if (password) payload.password = password;
  if (image) payload.image = image; // { url, pathname, iv }
  await redis.set(key, payload, { ex: TTL_SECONDS[mode] });

  // An orphan safety net (upload happened but note creation never followed)
  // already scheduled a 1-hour cleanup for this pathname when it was
  // uploaded (see POST /api/images) — this overwrites it with the note's
  // real TTL now that we know the image is actually attached to a note.
  if (image) await scheduleImageCleanup(image.pathname, TTL_SECONDS[mode]);
}

// Burn-after-read notes are looked up with an atomic GETDEL so two
// near-simultaneous requests can't both see the note before either deletes
// it. Timed notes are a plain GET and are left for Redis's own TTL to expire.
async function consumeNote(id) {
  const burned = await redis.getdel(burnKey(id));
  if (burned) return { ...burned, burnAfterRead: true };

  const timed = await redis.get(ttlKey(id));
  if (timed) return { ...timed, burnAfterRead: false };

  return null;
}

module.exports = { createNote, consumeNote, scheduleImageCleanup, dueImageCleanups, clearImageCleanup };
