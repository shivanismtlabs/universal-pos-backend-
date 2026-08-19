import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { EnterprisePrincipal } from './enterprise.types';

export const CurrentEnterprise = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EnterprisePrincipal => {
    const req = ctx.switchToHttp().getRequest<{ enterprise: EnterprisePrincipal }>();
    return req.enterprise;
  },
);
