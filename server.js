const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory only: nothing ever touches disk, and everything vanishes on
// restart. The server only ever sees ciphertext + an IV — the AES key
// lives in the URL fragment, which browsers never transmit to servers.
const notes = new Map();

const MAX_CIPHERTEXT_B64_LEN = 200_000; // ~150KB plaintext ceiling
const TTL_OPTIONS = new Set(['burn', '1h', '1d', '7d']);
const TTL_MS = { '1h': 3_600_000, '1d': 86_400_000, '7d': 604_800_000 };

function sweepExpired() {
  const now = Date.now();
  for (const [id, note] of notes) {
    if (note.expiresAt && note.expiresAt <= now) notes.delete(id);
  }
}
setInterval(sweepExpired, 60_000).unref();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/notes', (req, res) => {
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

app.get('/api/notes/:id', (req, res) => {
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

app.listen(PORT, () => {
  console.log(`sendnote listening on http://localhost:${PORT}`);
});
