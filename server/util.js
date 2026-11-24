export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export function str(v, { max, min = 0, field }) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max}).`);
  return s;
}

// Money is stored as whole centavos. Parsing is done on the text, never with floating point.
export function toCents(v, field = 'Amount') {
  const s = String(v ?? '').trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new HttpError(400, `${field} must be a number like 1500 or 1500.50.`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

// Returns "09XXXXXXXXX", "" for empty input, or null when the number is not a valid PH mobile number.
export function normalizeGcash(v) {
  const d = String(v ?? '').replace(/[\s-]/g, '');
  if (!d) return '';
  if (!/^(09\d{9}|\+639\d{9})$/.test(d)) return null;
  return d.startsWith('+63') ? '0' + d.slice(3) : d;
}

export const peso = (cents) =>
  '₱' + (cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
