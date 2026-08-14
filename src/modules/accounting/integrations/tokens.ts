import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptField, encryptField } from '../../security/field-crypto';

@Injectable()
export class IntegrationTokenService {
  constructor(private readonly config: ConfigService) {}

  encrypt(obj: Record<string, unknown>): string {
    return encryptField(JSON.stringify(obj), this.key());
  }

  decrypt(packed: string | null | undefined): Record<string, unknown> {
    if (!packed) return {};
    try {
      const raw = decryptField(packed, this.key());
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Public view never includes tokens. */
  publicConfig(cfg: Record<string, unknown>) {
    const {
      accessToken: _a,
      refreshToken: _r,
      clientSecret: _c,
      authorizationCode: _code,
      ...rest
    } = cfg;
    return {
      ...rest,
      hasAccessToken: Boolean(_a),
      hasRefreshToken: Boolean(_r),
    };
  }

  private key() {
    return (
      this.config.get<string>('SECURITY_DATA_KEY')?.trim() ||
      this.config.get<string>('JWT_ACCESS_SECRET')?.trim() ||
      'dev-only-change-me'
    );
  }
}
