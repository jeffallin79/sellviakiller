import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    if (!req.user) throw new UnauthorizedException('Not signed in');
    return req.user as AuthUser;
  },
);
