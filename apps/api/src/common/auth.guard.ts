import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { auth } from '../auth/better-auth';

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      throw new UnauthorizedException('Not signed in');
    }
    req.user = session.user;
    req.session = session.session;
    return true;
  }
}
