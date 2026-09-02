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
    const passwordToggle = $('password-toggle');
    const passwordField = $('password-field');
    const passwordInput = $('note-password');
    const passwordVisibilityBtn = $('password-visibility-btn');

    passwordToggle.addEventListener('change', () => {
      passwordField.hidden = !passwordToggle.checked;
      if (!passwordToggle.checked) {
        passwordInput.value = '';
      } else {
        passwordInput.focus();
      }
    });

    passwordVisibilityBtn.addEventListener('click', () => {
      togglePasswordVisibility(passwordInput, passwordVisibilityBtn);
    });

    createBtn.addEventListener('click', async () => {
      const text = input.value;
      errorEl.hidden = true;

      if (!text.trim()) {
        showError(errorEl, 'Write something first.');
        return;
      }

      const usePassword = passwordToggle.checked;
      const password = passwordInput.value;

      if (usePassword && !password) {
        showError(errorEl, 'Enter a password, or uncheck password protection.');
        return;
      }

      createBtn.disabled = true;
      createBtn.textContent = 'Encrypting…';

      try {
        const { ciphertextB64, ivB64, keyFragment, password: passwordMeta } = await SendNoteCrypto.encrypt(
          text,
          usePassword ? password : undefined
        );

        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ciphertext: ciphertextB64,
            iv: ivB64,
            ttl: ttl.value,
            ...(passwordMeta ? { password: passwordMeta } : {}),
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to create note.');
        }

        const { id } = await res.json();
        const link = passwordMeta
          ? `${location.origin}/n/${id}?p=1`
          : `${location.origin}/n/${id}#${keyFragment}`;

        input.value = '';
        passwordToggle.checked = false;
        passwordField.hidden = true;
        passwordInput.value = '';
        composeSection.hidden = true;
        showResult(link, ttl.value, Boolean(passwordMeta));
      } catch (err) {
        showError(errorEl, err.message || 'Something went wrong.');
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'Encrypt & create link';
      }
    });
  }

  function showResult(link, ttlValue, passwordProtected) {
    resultSection.hidden = false;

    const linkInput = $('result-link');
    const copyBtn = $('copy-btn');
    const noteEl = $('result-note');
    const newBtn = $('new-note-btn');

    linkInput.value = link;
    const expiryText =
      ttlValue === 'burn'
        ? 'This link works exactly once, then the note is deleted.'
        : `This link works until it expires (${ttlLabel(ttlValue)}).`;
    noteEl.textContent = passwordProtected
      ? `${expiryText} You'll need to share the password separately.`
      : expiryText;

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
    const hasPassword = new URLSearchParams(location.search).get('p') === '1';
    const gate = $('reveal-gate');
    const content = $('reveal-content');
    const revealBtn = $('reveal-btn');
    const revealedText = $('revealed-text');
    const statusEl = $('reveal-status');
    const errorEl = $('reveal-error');
    const passwordField = $('reveal-password-field');
    const passwordInput = $('reveal-password');
    const passwordHint = $('reveal-password-hint');
    const passwordVisibilityBtn = $('reveal-password-visibility-btn');

    if (!hasPassword && !keyFragment) {
      showError(errorEl, 'This link is missing its decryption key and cannot be opened.');
      gate.hidden = true;
      return;
    }

    if (hasPassword) {
      passwordField.hidden = false;
      passwordHint.hidden = false;
      passwordVisibilityBtn.addEventListener('click', () => {
        togglePasswordVisibility(passwordInput, passwordVisibilityBtn);
      });
    }

    revealBtn.addEventListener('click', async () => {
      const password = hasPassword ? passwordInput.value : '';
      if (hasPassword && !password) {
        showError(errorEl, 'Enter the password for this note.');
        return;
      }

      revealBtn.disabled = true;
      revealBtn.textContent = 'Loading…';

      let note;
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(id)}`);
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? 'This note is gone — already read, expired, or the link is wrong.'
              : 'Failed to load note.'
          );
        }
        note = await res.json();
      } catch (err) {
        showError(errorEl, err.message || 'Failed to load note.');
        gate.hidden = true;
        revealBtn.disabled = false;
        revealBtn.textContent = 'View note';
        return;
      }

      try {
        const plaintext = note.password
          ? await SendNoteCrypto.decryptWithPassword(
              note.ciphertext,
              note.iv,
              password,
              note.password.salt,
              note.password.iterations
            )
          : await SendNoteCrypto.decrypt(note.ciphertext, note.iv, keyFragment);

        gate.hidden = true;
        content.hidden = false;
        revealedText.textContent = plaintext;
        statusEl.textContent = note.burnAfterRead
          ? 'This note has been destroyed. It cannot be viewed again.'
          : 'This note will still expire on its own.';

        // Strip the key from the address bar so it can't linger in history/screenshots.
        history.replaceState(null, '', location.pathname);
      } catch (err) {
        showError(
          errorEl,
          note.password
            ? 'Incorrect password.'
            : err.message || 'Failed to decrypt this note — the link may be broken.'
        );
        gate.hidden = true;
      } finally {
        revealBtn.disabled = false;
        revealBtn.textContent = 'View note';
      }
    });
  }

  function togglePasswordVisibility(input, button) {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    button.textContent = isHidden ? 'Hide' : 'Show';
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }
})();
