/**
 * POS phone lookup — same digit strategy as Gupshup (91 + 10-digit local).
 * Avoids duplicate customers from +91 / 91 / 0 / bare 10-digit entry.
 */

export function phoneDigits(input: string): string {
  return input.replace(/\D/g, '');
}

export function normalizePhone(input: string): string {
  const digits = phoneDigits(input);
  if (!digits) return '';
  if (digits.length === 10) return `91${digits}`;
  if (digits.startsWith('0') && digits.length === 11) {
    return `91${digits.slice(1)}`;
  }
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.startsWith('91') && digits.length === 13) {
    return digits.slice(0, 12);
  }
  return digits;
}

/** Canonical stored form for new customers (E.164-ish with +). */
export function canonicalPhone(input: string): string {
  const n = normalizePhone(input);
  if (!n) return input.trim();
  return n.startsWith('+') ? n : `+${n}`;
}

export function phoneLookupVariants(input: string): string[] {
  const raw = input.trim();
  const digits = phoneDigits(raw);
  const normalized = normalizePhone(raw);
  const last10 =
    digits.length >= 10 ? digits.slice(-10) : digits.length ? digits : '';
  const variants = new Set<string>();
  if (raw) variants.add(raw);
  if (digits) variants.add(digits);
  if (normalized) {
    variants.add(normalized);
    variants.add(`+${normalized}`);
  }
  if (last10) {
    variants.add(last10);
    variants.add(`91${last10}`);
    variants.add(`+91${last10}`);
    variants.add(`0${last10}`);
  }
  return [...variants].filter((v) => v.length >= 7 && v.length <= 22);
}

export function maskPhone(phone: string | null | undefined): string {
  const digits = phoneDigits(phone ?? '');
  if (digits.length < 4) return '••••';
  return `••••••${digits.slice(-4)}`;
}
