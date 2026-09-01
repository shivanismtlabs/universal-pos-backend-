/**
 * Country → suggested UOM symbols (configuration, not application branches).
 * Resolved at runtime against the Unit master — new countries/units need no code change
 * once rows exist in this map or country_uom_defaults (future).
 */

export type CountryUomProfile = {
  countryCode: string;
  label: string;
  /** metric | imperial | mixed — informational only */
  measureSystem: 'metric' | 'imperial' | 'mixed';
  /** Suggested unit symbols for onboarding / Settings hints */
  suggestedSymbols: string[];
};

/** ISO 3166-1 alpha-2 → suggested symbols (enable/disable is tenant choice) */
export const COUNTRY_UOM_PROFILES: Record<string, CountryUomProfile> = {
  IN: {
    countryCode: 'IN',
    label: 'India',
    measureSystem: 'metric',
    suggestedSymbols: [
      'pcs',
      'kg',
      'g',
      'L',
      'ml',
      'dozen',
      'box',
      'bag',
      'carton',
      'pair',
      'm',
      'm2',
      'hour',
      'service',
    ],
  },
  US: {
    countryCode: 'US',
    label: 'United States',
    measureSystem: 'imperial',
    suggestedSymbols: [
      'pcs',
      'lb',
      'oz',
      'gal',
      'fl oz',
      'dozen',
      'box',
      'case',
      'in',
      'ft',
      'hour',
      'service',
    ],
  },
  GB: {
    countryCode: 'GB',
    label: 'United Kingdom',
    measureSystem: 'mixed',
    suggestedSymbols: [
      'pcs',
      'kg',
      'g',
      'L',
      'ml',
      'pt',
      'dozen',
      'box',
      'pair',
      'm',
      'hour',
      'service',
    ],
  },
  AU: {
    countryCode: 'AU',
    label: 'Australia',
    measureSystem: 'metric',
    suggestedSymbols: ['pcs', 'kg', 'g', 'L', 'ml', 'box', 'dozen', 'm', 'hour', 'service'],
  },
  CA: {
    countryCode: 'CA',
    label: 'Canada',
    measureSystem: 'mixed',
    suggestedSymbols: ['pcs', 'kg', 'g', 'lb', 'oz', 'L', 'ml', 'box', 'dozen', 'hour', 'service'],
  },
  AE: {
    countryCode: 'AE',
    label: 'United Arab Emirates',
    measureSystem: 'metric',
    suggestedSymbols: ['pcs', 'kg', 'g', 'L', 'ml', 'box', 'dozen', 'hour', 'service'],
  },
  SG: {
    countryCode: 'SG',
    label: 'Singapore',
    measureSystem: 'metric',
    suggestedSymbols: ['pcs', 'kg', 'g', 'L', 'ml', 'box', 'dozen', 'hour', 'service'],
  },
};

const FALLBACK: CountryUomProfile = {
  countryCode: 'XX',
  label: 'International',
  measureSystem: 'metric',
  suggestedSymbols: [
    'pcs',
    'kg',
    'g',
    'L',
    'ml',
    'lb',
    'oz',
    'box',
    'dozen',
    'm',
    'hour',
    'service',
  ],
};

export function normalizeCountryCode(raw?: string | null): string {
  const c = (raw ?? '').trim().toUpperCase();
  return c.length === 2 ? c : 'IN';
}

export function countryUomProfile(countryCode?: string | null): CountryUomProfile {
  const code = normalizeCountryCode(countryCode);
  return COUNTRY_UOM_PROFILES[code] ?? { ...FALLBACK, countryCode: code };
}

/** Read country from tenant.settings.organizationProfile.countryCode */
export function countryCodeFromTenantSettings(settings: unknown): string {
  if (!settings || typeof settings !== 'object') return 'IN';
  const root = settings as Record<string, unknown>;
  const org = root.organizationProfile;
  if (!org || typeof org !== 'object') return 'IN';
  return normalizeCountryCode((org as Record<string, unknown>).countryCode as string);
}
