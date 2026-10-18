#!/usr/bin/env node
// Command-line client for sendnote. Encryption happens here, locally, with
// the exact same helpers the browser uses (public/crypto.js), so the server
// still only ever sees ciphertext and links are interchangeable with the
// web app in both directions.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const SendNoteCrypto = require('../public/crypto.js');
const { version } = require('../package.json');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // must match server.js
const TTL_OPTIONS = ['burn', '1h', '1d', '7d']; // must match server.js
const TTL_LABELS = { '1h': '1 hour', '1d': '1 day', '7d': '7 days' };
const DEFAULT_SERVER = 'http://localhost:3000';

const USAGE = `sendnote ${version} - zero-knowledge encrypted note sharing

Usage:
  sendnote send [text...] [options]   Encrypt a note and print its link
  sendnote read <link> [options]      Fetch and decrypt a note

  With no command, "send" is assumed. If no text is given, the note is read
  from stdin (pipe it in, or type it and end with Ctrl+D / Ctrl+Z Enter).

Send options:
  -t, --ttl <ttl>        burn (default, one read), 1h, 1d or 7d
  -p, --password         Protect with a password instead of a key in the link
  -i, --image <file>     Attach an image (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)
  -s, --server <url>     Server to use (default: $SENDNOTE_URL or ${DEFAULT_SERVER})

Read options:
  -o, --output <file>    Where to save an attached image
                         (default: ./sendnote-<id>.<ext>)

General:
  -h, --help             Show this help
  -v, --version          Show the version

Passwords are prompted for without echo. For scripts, set SENDNOTE_PASSWORD
instead.

Examples:
  sendnote "the wifi password is hunter2"
  cat secrets.env | sendnote send --ttl 1h
  sendnote send -p -i photo.jpg "see attached"
  sendnote read "https://example.com/n/AbC...#key"
`;

class CliError extends Error {}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ttl: { type: 'string', short: 't', default: 'burn' },
      password: { type: 'boolean', short: 'p' },
      image: { type: 'string', short: 'i' },
      server: { type: 'string', short: 's' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) return void process.stdout.write(USAGE);
  if (values.version) return void process.stdout.write(`${version}\n`);

  const [command, ...rest] = positionals;
  if (command === 'read') return read(rest, values);
  if (command === 'send') return send(rest, values);
  return send(positionals, values);
}

async function send(textArgs, opts) {
  if (!TTL_OPTIONS.includes(opts.ttl)) {
    throw new CliError(`--ttl must be one of: ${TTL_OPTIONS.join(', ')}`);
  }
  const server = normalizeServer(opts.server || process.env.SENDNOTE_URL || DEFAULT_SERVER);

  let imageBytes;
  if (opts.image) {
    let stat;
    try {
      stat = fs.statSync(opts.image);
    } catch {
      throw new CliError(`Cannot read image: ${opts.image}`);
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new CliError(`Image is too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`);
    }
    imageBytes = fs.readFileSync(opts.image);
  }

  // Ask for the password before reading the note from stdin: once a TTY
  // has been read to EOF it can't be used for the prompt any more.
  const password = opts.password ? await getPassword('Password: ', true) : undefined;

  const text = textArgs.length > 0 ? textArgs.join(' ') : await readStdin(Boolean(imageBytes));
  if (!text.trim() && !imageBytes) {
    throw new CliError('Write something or attach an image first.');
  }

  const { ciphertextB64, ivB64, keyFragment, password: passwordMeta, key } = await SendNoteCrypto.encrypt(
    text,
    password
  );

  let imageMeta;
  if (imageBytes) {
    const { ciphertext, ivB64: imageIvB64 } = await SendNoteCrypto.encryptBytes(imageBytes, key);
    status('Uploading image…');
    const { pathname } = await request(server, `/api/images?burn=${opts.ttl === 'burn' ? '1' : '0'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
    });
    imageMeta = { pathname, iv: imageIvB64 };
  }

  const { id } = await request(server, '/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ciphertext: ciphertextB64,
      iv: ivB64,
      ttl: opts.ttl,
      ...(passwordMeta ? { password: passwordMeta } : {}),
      ...(imageMeta ? { image: imageMeta } : {}),
    }),
  });

  const link = passwordMeta ? `${server}/n/${id}?p=1` : `${server}/n/${id}#${keyFragment}`;

  // Only the link goes to stdout, so `sendnote ... | pbcopy` works as expected.
  process.stdout.write(`${link}\n`);
  const expiryText =
    opts.ttl === 'burn'
      ? 'This link works exactly once, then the note is deleted.'
      : `This link works until it expires (${TTL_LABELS[opts.ttl]}).`;
  status(passwordMeta ? `${expiryText} Share the password separately.` : expiryText);
}

async function read(args, opts) {
  if (args.length !== 1) throw new CliError('Usage: sendnote read <link>');

  let url;
  try {
    url = new URL(args[0]);
  } catch {
    throw new CliError('That is not a valid sendnote link.');
  }
  const match = url.pathname.match(/^\/n\/([A-Za-z0-9_-]+)$/);
  if (!match) throw new CliError('That is not a valid sendnote link.');
  const id = match[1];
  const keyFragment = url.hash.slice(1);
  const hasPassword = url.searchParams.get('p') === '1';

  if (!hasPassword && !keyFragment) {
    throw new CliError('This link is missing its decryption key and cannot be opened.');
  }

  // Prompt before fetching: for a burn note the fetch itself destroys it.
  const password = hasPassword ? await getPassword('Password: ', false) : undefined;

  let note;
  try {
    note = await request(url.origin, `/api/notes/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.status === 404) throw new CliError('This note is gone — already read, expired, or the link is wrong.');
    throw err;
  }

  let plaintext, key;
  try {
    ({ plaintext, key } = note.password
      ? await SendNoteCrypto.decryptWithPassword(
          note.ciphertext,
          note.iv,
          password,
          note.password.salt,
          note.password.iterations
        )
      : await SendNoteCrypto.decrypt(note.ciphertext, note.iv, keyFragment));
  } catch {
    throw new CliError(
      note.password ? 'Incorrect password.' : 'Failed to decrypt this note — the link may be broken.'
    );
  }

  if (plaintext) {
    process.stdout.write(plaintext);
    if (process.stdout.isTTY && !plaintext.endsWith('\n')) process.stdout.write('\n');
  }

  // A burn-mode image is deleted as soon as it's served, so always save it
  // rather than making it opt-in — skipping it would lose it for good.
  if (note.image) {
    const res = await fetchOrFail(url.origin, `/api/images?p=${encodeURIComponent(note.image.pathname)}`);
    if (!res.ok) throw new CliError('Failed to load the attached image.');
    const bytes = Buffer.from(
      await SendNoteCrypto.decryptBytes(await res.arrayBuffer(), note.image.iv, key)
    );
    const outPath = opts.output || freeFilename(`sendnote-${id}`, sniffImageExtension(bytes));
    fs.writeFileSync(outPath, bytes);
    status(`Image saved to ${path.resolve(outPath)}`);
  }

  status(
    note.burnAfterRead
      ? 'This note has been destroyed. It cannot be viewed again.'
      : 'This note will still expire on its own.'
  );
}

function normalizeServer(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`Invalid server URL: ${raw}`);
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    status(`Warning: ${url.origin} is not HTTPS; ciphertext will travel unencrypted.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

async function fetchOrFail(base, pathAndQuery, init) {
  try {
    return await fetch(base + pathAndQuery, init);
  } catch {
    throw new CliError(`Could not reach ${base}`);
  }
}

async function request(base, pathAndQuery, init) {
  const res = await fetchOrFail(base, pathAndQuery, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new CliError(body.error || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function getPassword(prompt, confirm) {
  if (process.env.SENDNOTE_PASSWORD) return process.env.SENDNOTE_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new CliError('stdin is not a terminal, so the password cannot be prompted for. Set SENDNOTE_PASSWORD.');
  }
  const password = await promptHidden(prompt);
  if (!password) throw new CliError('Password cannot be empty.');
  if (confirm && (await promptHidden('Confirm password: ')) !== password) {
    throw new CliError('Passwords do not match.');
  }
  return password;
}

function promptHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    let value = '';
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    function finish() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    }

    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish();
          return resolve(value);
        }
        if (ch === '\u0003') {
          finish();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    }

    stdin.on('data', onData);
  });
}

async function readStdin(optional) {
  if (process.stdin.isTTY) {
    if (optional) return '';
    status('Type your note, then press Ctrl+D (Ctrl+Z then Enter on Windows):');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The note doesn't record the image's type (the browser just hands the bytes
// to an <img>), so pick a file extension from the magic bytes.
function sniffImageExtension(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const brand = b.subarray(4, 12).toString('ascii');
  if (brand === 'ftypavif') return 'avif';
  if (brand === 'ftypheic' || brand === 'ftypmif1') return 'heic';
  return 'bin';
}

// The image may already be deleted server-side by now (burn mode), so a
// name collision must not fail the write — pick the next free name instead.
function freeFilename(base, ext) {
  let candidate = `${base}.${ext}`;
  for (let n = 1; fs.existsSync(candidate); n++) candidate = `${base}-${n}.${ext}`;
  return candidate;
}

function status(message) {
  process.stderr.write(`${message}\n`);
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof CliError || err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    status(`sendnote: ${err.message}`);
  } else {
    status(`sendnote: ${err.stack || err}`);
  }
  // Not process.exit(): on Windows, exiting while fetch() handles are still
  // closing trips a libuv assertion.
  process.exitCode = 1;
});
