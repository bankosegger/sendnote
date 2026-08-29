(() => {
  const $ = (id) => document.getElementById(id);

  const composeSection = $('compose');
  const resultSection = $('result');
  const revealSection = $('reveal');

  const noteMatch = location.pathname.match(/^\/n\/([A-Za-z0-9_-]+)$/);

  if (noteMatch) {
    initReveal(noteMatch[1]);
  } else {
    initCompose();
  }

  function initCompose() {
    composeSection.hidden = false;

    const input = $('note-input');
    const ttl = $('ttl');
    const createBtn = $('create-btn');
    const errorEl = $('compose-error');

    createBtn.addEventListener('click', async () => {
      const text = input.value;
      errorEl.hidden = true;

      if (!text.trim()) {
        showError(errorEl, 'Write something first.');
        return;
      }

      createBtn.disabled = true;
      createBtn.textContent = 'Encrypting…';

      try {
        const { ciphertextB64, ivB64, keyFragment } = await SendNoteCrypto.encrypt(text);

        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ciphertext: ciphertextB64, iv: ivB64, ttl: ttl.value }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to create note.');
        }

        const { id } = await res.json();
        const link = `${location.origin}/n/${id}#${keyFragment}`;

        input.value = '';
        composeSection.hidden = true;
        showResult(link, ttl.value);
      } catch (err) {
        showError(errorEl, err.message || 'Something went wrong.');
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'Encrypt & create link';
      }
    });
  }

  function showResult(link, ttlValue) {
    resultSection.hidden = false;

    const linkInput = $('result-link');
    const copyBtn = $('copy-btn');
    const noteEl = $('result-note');
    const newBtn = $('new-note-btn');

    linkInput.value = link;
    noteEl.textContent =
      ttlValue === 'burn'
        ? 'This link works exactly once, then the note is deleted.'
        : `This link works until it expires (${ttlLabel(ttlValue)}).`;

    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    });

    newBtn.addEventListener('click', () => {
      resultSection.hidden = true;
      composeSection.hidden = false;
    });
  }

  function ttlLabel(v) {
    return { '1h': '1 hour', '1d': '1 day', '7d': '7 days' }[v] || v;
  }

  function initReveal(id) {
    revealSection.hidden = false;

    const keyFragment = location.hash.slice(1);
    const gate = $('reveal-gate');
    const content = $('reveal-content');
    const revealBtn = $('reveal-btn');
    const revealedText = $('revealed-text');
    const statusEl = $('reveal-status');
    const errorEl = $('reveal-error');

    if (!keyFragment) {
      showError(errorEl, 'This link is missing its decryption key and cannot be opened.');
      gate.hidden = true;
      return;
    }

    revealBtn.addEventListener('click', async () => {
      revealBtn.disabled = true;
      revealBtn.textContent = 'Loading…';

      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(id)}`);
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? 'This note is gone — already read, expired, or the link is wrong.'
              : 'Failed to load note.'
          );
        }
        const { ciphertext, iv, burnAfterRead } = await res.json();
        const plaintext = await SendNoteCrypto.decrypt(ciphertext, iv, keyFragment);

        gate.hidden = true;
        content.hidden = false;
        revealedText.textContent = plaintext;
        statusEl.textContent = burnAfterRead
          ? 'This note has been destroyed. It cannot be viewed again.'
          : 'This note will still expire on its own.';

        // Strip the key from the address bar so it can't linger in history/screenshots.
        history.replaceState(null, '', location.pathname);
      } catch (err) {
        showError(errorEl, err.message || 'Failed to decrypt this note — the link may be broken.');
        gate.hidden = true;
      }
    });
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }
})();
