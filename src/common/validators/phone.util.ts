import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
} from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

function asCountry(code?: string): CountryCode | undefined {
  const c = (code ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return c as CountryCode;
  return undefined;
}

/** Validate international phone (E.164 or national with optional default country). */
export function isInternationalPhoneValue(
  value: unknown,
  defaultCountry?: string,
): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 22) return false;
  try {
    if (trimmed.startsWith('+')) {
      return isValidPhoneNumber(trimmed);
    }
    const cc = asCountry(defaultCountry) ?? 'IN';
    return isValidPhoneNumber(trimmed, cc);
  } catch {
    return false;
  }
}

/** Normalize to E.164 when valid; otherwise return trimmed input. */
export function canonicalPhoneE164(
  input: string,
  defaultCountry = 'IN',
): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const parsed = trimmed.startsWith('+')
      ? parsePhoneNumberFromString(trimmed)
      : parsePhoneNumberFromString(trimmed, asCountry(defaultCountry) ?? 'IN');
    if (parsed?.isValid()) return parsed.format('E.164');
  } catch {
    /* fall through */
  }
  return trimmed;
}
