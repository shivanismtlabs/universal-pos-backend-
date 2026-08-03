export type JwtPayload = {
  sub: string;
  tenantId: string;
  email: string;
  roles: string[];
  storeId?: string | null;
  typ: 'access' | 'refresh';
};

export type AuthUser = {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
  storeId?: string | null;
  fullName: string;
};
