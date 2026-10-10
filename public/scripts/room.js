/**
 * Sway – Booth codes
 *
 * Every booth (a laptop running /app) has a short random code. A phone joins a
 * booth by opening /controller/CODE (the QR code) or typing the code in. There
 * are no accounts: the code *is* the booth, and the server only relays motion
 * between clients that share a code.
 *
 * Shared by the browser scripts AND the server (server/index.js imports
 * isRoomCode / normaliseRoomCode), so nothing here may touch the DOM at load.
 */

// No 0/O, 1/I/L — easy to read off a laptop screen and type on a phone.
export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_LENGTH   = 6;   // 31^6 ≈ 887 million codes

const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_LENGTH}}$`);

/** Uppercase and drop spaces/dashes, so "k7p-3qx" → "K7P3QX". */
export function normaliseRoomCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function isRoomCode(code) {
  return typeof code === 'string' && ROOM_RE.test(code);
}

/** "K7P3QX" → "K7P 3QX" for display. */
export function formatRoomCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** Cryptographically random, unbiased code (browser only). */
export function generateRoomCode() {
  const n = ROOM_ALPHABET.length;
  const limit = Math.floor(256 / n) * n; // reject bytes ≥ limit to avoid modulo bias
  const bytes = new Uint8Array(ROOM_LENGTH * 2);
  let code = '';
  while (code.length < ROOM_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && code.length < ROOM_LENGTH) code += ROOM_ALPHABET[b % n];
    }
  }
  return code;
}