// Minimal AES-256-GCM helpers built on the Web Crypto API.
// The key never leaves the browser: it is generated client-side and
// carried only in the URL fragment, which is never sent in HTTP requests.

const SendNoteCrypto = (() => {
  function bufToB64url(buf) {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBuf(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function bufToB64(buf) {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToBuf(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  const PBKDF2_ITERATIONS = 250_000;

  async function deriveKeyFromPassword(password, salt, iterations, usages) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  // With a password: the AES key is derived from it (PBKDF2 + random salt),
  // so it never travels in the URL — only the non-secret salt/iterations do.
  // Without one: a random key is generated and carried in the URL fragment,
  // which browsers never send to the server.
  async function encrypt(plaintext, password) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    if (password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKeyFromPassword(password, salt, PBKDF2_ITERATIONS, ['encrypt']);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

      return {
        ciphertextB64: bufToB64(ciphertext),
        ivB64: bufToB64(iv),
        keyFragment: null,
        password: { salt: bufToB64(salt), iterations: PBKDF2_ITERATIONS },
      };
    }

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const rawKey = await crypto.subtle.exportKey('raw', key);

    return {
      ciphertextB64: bufToB64(ciphertext),
      ivB64: bufToB64(iv),
      keyFragment: bufToB64url(rawKey),
      password: null,
    };
  }

  async function decrypt(ciphertextB64, ivB64, keyFragment) {
    const rawKey = b64urlToBuf(keyFragment);
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = new Uint8Array(b64ToBuf(ivB64));
    const ciphertext = b64ToBuf(ciphertextB64);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  }

  async function decryptWithPassword(ciphertextB64, ivB64, password, saltB64, iterations) {
    const salt = new Uint8Array(b64ToBuf(saltB64));
    const key = await deriveKeyFromPassword(password, salt, iterations, ['decrypt']);
    const iv = new Uint8Array(b64ToBuf(ivB64));
    const ciphertext = b64ToBuf(ciphertextB64);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  }

  return { encrypt, decrypt, decryptWithPassword };
})();
