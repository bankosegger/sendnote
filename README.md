# sendnote

Share encrypted notes that disappear. Zero-knowledge, we never see the plaintext.

## How it works

Write a note, it gets encrypted in your browser, and you get a link to share. The encryption key lives in the URL fragment (`#key`), which your browser never sends to the server. We only store the ciphertext. Nobody else can read it.

## Install & run

```bash
npm install
npm start
```

Visit `http://localhost:3000`

## Features

- **Encrypted in-browser** — plaintext never leaves your computer
- **Auto-expire** — burn on read, or set a timer (1h, 1d, 7d)
- **Zero-knowledge** — server only sees ciphertext
- **In-memory only** — notes are gone when the server restarts
