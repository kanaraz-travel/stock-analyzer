export function normalizeTicker(input) {
  let t = String(input ?? '').trim();
  if (t.length === 7 && t[0] === 'A') t = t.slice(1);
  return t.toUpperCase();
}
export function isValidTicker(input) {
  return /^[0-9A-Z]{6}$/.test(normalizeTicker(input));
}