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

async function createNote(id, { ciphertext, iv }, mode) {
  const key = mode === 'burn' ? burnKey(id) : ttlKey(id);
  await redis.set(key, { ciphertext, iv }, { ex: TTL_SECONDS[mode] });
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

module.exports = { createNote, consumeNote };
