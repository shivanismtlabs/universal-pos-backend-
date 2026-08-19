import {
  isCorsOriginAllowed,
  loginThrottleLimit,
  resolveCorsAllowlist,
  shouldExposeDevOtp,
} from './cors-origins';
import { applyApiSecurityHeaders } from './http-security-headers';

describe('cors allowlist', () => {
  it('never includes an unlisted origin in production', () => {
    const list = resolveCorsAllowlist({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://upos.walit.in',
    });
    expect(list).toEqual(['https://upos.walit.in']);
    expect(isCorsOriginAllowed('https://evil.example', list)).toBe(false);
    expect(isCorsOriginAllowed('https://upos.walit.in', list)).toBe(true);
    expect(isCorsOriginAllowed(undefined, list)).toBe(true);
  });

  it('allows localhost in non-production', () => {
    const list = resolveCorsAllowlist({ NODE_ENV: 'development' });
    expect(isCorsOriginAllowed('http://localhost:3000', list)).toBe(true);
    expect(isCorsOriginAllowed('https://evil.example', list)).toBe(false);
  });
});

describe('OTP expose policy', () => {
  it('never exposes OTP in production even if AUTH_OTP_RETURN_CODE=1', () => {
    expect(
      shouldExposeDevOtp({ NODE_ENV: 'production', AUTH_OTP_RETURN_CODE: '1' }),
    ).toBe(false);
  });

  it('exposes OTP in development unless AUTH_OTP_RETURN_CODE=0', () => {
    expect(shouldExposeDevOtp({ NODE_ENV: 'development' })).toBe(true);
    expect(
      shouldExposeDevOtp({ NODE_ENV: 'development', AUTH_OTP_RETURN_CODE: '0' }),
    ).toBe(false);
  });
});

describe('login throttle policy', () => {
  it('uses 30/min in production and 60/min in development', () => {
    expect(loginThrottleLimit({ NODE_ENV: 'production' })).toBe(30);
    expect(loginThrottleLimit({ NODE_ENV: 'development' })).toBe(60);
  });
});

describe('API security headers', () => {
  it('sets XCTO, frame, referrer and CSP except on /docs', () => {
    const headers: Record<string, string> = {};
    const reply = {
      header(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
    };
    applyApiSecurityHeaders(reply, '/v1/auth/me');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['content-security-policy']).toContain("default-src 'none'");

    const docs: Record<string, string> = {};
    applyApiSecurityHeaders(
      {
        header(name: string, value: string) {
          docs[name.toLowerCase()] = value;
        },
      },
      '/docs',
    );
    expect(docs['content-security-policy']).toBeUndefined();
    expect(docs['x-content-type-options']).toBe('nosniff');
  });
});
