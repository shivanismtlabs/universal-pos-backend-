export type JwtTokenTyp = 'access' | 'refresh' | 'station' | 'pin_access';

export type JwtPayload = {
  sub: string;
  tenantId: string;
  email: string;
  roles: string[];
  /** Preferred: location scope */
  locationId?: string | null;
  /** @deprecated alias of locationId for older clients */
  storeId?: string | null;
  typ: JwtTokenTyp;
};

export type AuthUser = {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
  locationId?: string | null;
  /** @deprecated alias of locationId */
  storeId?: string | null;
  fullName: string;
  /** JWT typ that authenticated this request */
  tokenTyp?: JwtTokenTyp;
};
