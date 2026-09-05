(() => {
  const $ = (id) => document.getElementById(id);

  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // must match server.js
  const IMAGE_MAX_DIMENSION = 2000;
  const IMAGE_JPEG_QUALITY = 0.85;
  const IMAGE_SKIP_DOWNSCALE_BELOW_BYTES = 1.5 * 1024 * 1024; // not worth the CPU/quality cost below this

  // Large photos (phone cameras routinely produce 5-8MB files) dominate
  // upload time, especially on a slow uplink. Downscale/recompress before
  // encrypting so a typical photo shrinks to a few hundred KB. GIFs are left
  // alone since a canvas redraw would collapse them to their first frame.
  async function maybeDownscaleImage(file) {
    if (file.type === 'image/gif' || file.size < IMAGE_SKIP_DOWNSCALE_BELOW_BYTES) return file;

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      if (scale >= 1) return file;

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      // Flatten transparency to white before JPEG encoding (which has no alpha channel).
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', IMAGE_JPEG_QUALITY));
      return blob && blob.size < file.size ? blob : file;
    } catch {
      return file; // decode/canvas failure - fall back to uploading the original
    } finally {
      bitmap?.close?.();
    }
  }

  // fetch() has no upload progress event, so use XHR for the one request
  // large enough (an encrypted image) for progress feedback to matter.
  function uploadWithProgress(url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.onload = () => {
        let parsed = {};
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          // ignore - handled by the status check below
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || 'Failed to upload image.'));
        }
      };
      xhr.onerror = () => reject(new Error('Failed to upload image.'));
      xhr.send(body);
    });
  }

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
    const imageInput = $('note-image');
    const imagePreviewWrap = $('note-image-preview-wrap');
    const imagePreview = $('note-image-preview');
    const removeImageBtn = $('remove-image-btn');
    const createBtnLabel = $('create-btn-label');
    const createBtnSpinner = $('create-btn-spinner');

    function setPasswordProtectionEnabled(enabled) {
      passwordToggle.setAttribute('aria-pressed', String(enabled));
      passwordToggle.textContent = enabled ? 'On' : 'Off';
      passwordField.hidden = !enabled;
      if (!enabled) {
        passwordInput.value = '';
      } else {
        passwordInput.focus();
      }
    }

    passwordToggle.addEventListener('click', () => {
      setPasswordProtectionEnabled(passwordToggle.getAttribute('aria-pressed') !== 'true');
    });

    passwordVisibilityBtn.addEventListener('click', () => {
      togglePasswordVisibility(passwordInput, passwordVisibilityBtn);
    });

    imageInput.addEventListener('change', () => {
      errorEl.hidden = true;
      const file = imageInput.files[0];
      if (!file) {
        resetImagePicker();
        return;
      }
      if (!file.type.startsWith('image/')) {
        showError(errorEl, 'That file is not an image.');
        resetImagePicker();
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        showError(errorEl, `Image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
        resetImagePicker();
        return;
      }
      imagePreview.src = URL.createObjectURL(file);
      imagePreviewWrap.hidden = false;
    });

    removeImageBtn.addEventListener('click', () => resetImagePicker());

    function resetImagePicker() {
      imageInput.value = '';
      if (imagePreview.src) URL.revokeObjectURL(imagePreview.src);
      imagePreview.src = '';
      imagePreviewWrap.hidden = true;
    }

    createBtn.addEventListener('click', async () => {
      const text = input.value;
      const imageFile = imageInput.files[0];
      errorEl.hidden = true;

      if (!text.trim() && !imageFile) {
        showError(errorEl, 'Write something or attach an image first.');
        return;
      }

      const usePassword = passwordToggle.getAttribute('aria-pressed') === 'true';
      const password = passwordInput.value;

      if (usePassword && !password) {
        showError(errorEl, 'Enter a password, or uncheck password protection.');
        return;
      }

      createBtn.disabled = true;
      createBtnSpinner.hidden = false;
      createBtnLabel.textContent = 'Encrypting…';

      try {
        const {
          ciphertextB64,
          ivB64,
          keyFragment,
          password: passwordMeta,
          key,
        } = await SendNoteCrypto.encrypt(text, usePassword ? password : undefined);

        let imageMeta;
        if (imageFile) {
          const uploadFile = await maybeDownscaleImage(imageFile);
          const bytes = await uploadFile.arrayBuffer();
          const { ciphertext: imageCiphertext, ivB64: imageIvB64 } = await SendNoteCrypto.encryptBytes(bytes, key);

          createBtnLabel.textContent = 'Uploading image… 0%';
          const { pathname } = await uploadWithProgress(
            `/api/images?burn=${ttl.value === 'burn' ? '1' : '0'}`,
            imageCiphertext,
            (fraction) => {
              createBtnLabel.textContent = `Uploading image… ${Math.round(fraction * 100)}%`;
            }
          );
          imageMeta = { pathname, iv: imageIvB64 };
        }

        createBtnLabel.textContent = 'Encrypting…';

        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ciphertext: ciphertextB64,
            iv: ivB64,
            ttl: ttl.value,
            ...(passwordMeta ? { password: passwordMeta } : {}),
            ...(imageMeta ? { image: imageMeta } : {}),
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
        setPasswordProtectionEnabled(false);
        resetImagePicker();
        composeSection.hidden = true;
        showResult(link, ttl.value, Boolean(passwordMeta));
      } catch (err) {
        showError(errorEl, err.message || 'Something went wrong.');
      } finally {
        createBtn.disabled = false;
        createBtnSpinner.hidden = true;
        createBtnLabel.textContent = 'Encrypt & create link';
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
    const revealBtnLabel = $('reveal-btn-label');
    const revealBtnSpinner = $('reveal-btn-spinner');
    const revealedText = $('revealed-text');
    const revealedImage = $('revealed-image');
    const revealedImageLoading = $('revealed-image-loading');
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
      revealBtnLabel.textContent = 'Loading…';
      revealBtnSpinner.hidden = false;

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
        revealBtnLabel.textContent = 'View note';
        revealBtnSpinner.hidden = true;
        return;
      }

      try {
        const { plaintext, key } = note.password
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
        revealedText.hidden = !plaintext;
        statusEl.textContent = note.burnAfterRead
          ? 'This note has been destroyed. It cannot be viewed again.'
          : 'This note will still expire on its own.';

        // Strip the key from the address bar so it can't linger in history/screenshots.
        history.replaceState(null, '', location.pathname);

        // The note text is already revealed at this point, so a failure here
        // (unlike above) shouldn't re-trigger the gate or an "incorrect
        // password" message — just report the image separately.
        if (note.image) {
          revealedImageLoading.hidden = false;
          try {
            const imgRes = await fetch(`/api/images?p=${encodeURIComponent(note.image.pathname)}`);
            if (!imgRes.ok) throw new Error();
            const encryptedBytes = await imgRes.arrayBuffer();
            const decryptedBytes = await SendNoteCrypto.decryptBytes(encryptedBytes, note.image.iv, key);
            revealedImage.src = URL.createObjectURL(new Blob([decryptedBytes]));
            revealedImage.hidden = false;
          } catch {
            showError(errorEl, 'Failed to load the attached image.');
          } finally {
            revealedImageLoading.hidden = true;
          }
        }
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
        revealBtnLabel.textContent = 'View note';
        revealBtnSpinner.hidden = true;
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
