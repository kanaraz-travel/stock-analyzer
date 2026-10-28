const ITERATIONS = 10000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt);
  return `${b64(salt)}:${b64(hash)}`;
}
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [saltB64, expectedB64] = stored.split(':');
  if (!saltB64 || !expectedB64) return false;
  const actual = await pbkdf2(password, unb64(saltB64));
  const expected = unb64(expectedB64);
  return timingSafeEqual(actual, expected);
}
async function pbkdf2(password, salt) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, km, HASH_BITS);
  return new Uint8Array(bits);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}