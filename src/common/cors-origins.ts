export type CorsEnv = {
  NODE_ENV?: string;
  CORS_ALLOWED_ORIGINS?: string;
  PUBLIC_APP_URL?: string;
  WEBAUTHN_ORIGIN?: string;
};

function splitCsv(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** Explicit allowlist. Never `*` and never reflect arbitrary origins. */
export function resolveCorsAllowlist(env: CorsEnv = process.env): string[] {
  const merged = [
    ...splitCsv(env.CORS_ALLOWED_ORIGINS),
    ...splitCsv(env.PUBLIC_APP_URL),
    ...splitCsv(env.WEBAUTHN_ORIGIN),
  ];
  if (env.NODE_ENV !== 'production') {
    merged.push(
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
    );
  }
  return [...new Set(merged)];
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  allowlist: string[],
): boolean {
  if (!origin) return true;
  return allowlist.includes(origin.replace(/\/$/, ''));
}

export function loginThrottleLimit(env: CorsEnv & { AUTH_LOGIN_THROTTLE_LIMIT?: string } = process.env): number {
  const n = Number(env.AUTH_LOGIN_THROTTLE_LIMIT);
  if (Number.isFinite(n) && n >= 5) return Math.floor(n);
  return env.NODE_ENV === 'production' ? 30 : 60;
}

/** Production never returns OTP; non-prod may unless AUTH_OTP_RETURN_CODE=0. */
export function shouldExposeDevOtp(env: {
  NODE_ENV?: string;
  AUTH_OTP_RETURN_CODE?: string;
} = process.env): boolean {
  if (env.NODE_ENV === 'production') return false;
  return env.AUTH_OTP_RETURN_CODE !== '0';
}
