import { Controller, Post, Body, Get, UseGuards, Req, Res, All, Next } from '@nestjs/common';
import { ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request, Response, NextFunction } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { SignUpSchema } from '@storeforge/shared';
import { auth } from './better-auth';
import { AuthService } from './auth.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';

const betterAuthHandler = toNodeHandler(auth);

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('auth/bootstrap')
  async bootstrap(@Body() body: unknown) {
    const input = SignUpSchema.parse(body);
    return this.authService.signUpAndCreateAccount(input);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: { id: string }) {
    return this.authService.getMe(user.id);
  }

  /** Better Auth routes under /api/auth/* (except bootstrap handled above) */
  @All('auth')
  @ApiExcludeEndpoint()
  async handleAuthRoot(@Req() req: Request, @Res() res: Response) {
    return betterAuthHandler(req, res);
  }

  @All('auth/*')
  @ApiExcludeEndpoint()
  async handleAuth(@Req() req: Request, @Res() res: Response) {
    return betterAuthHandler(req, res);
  }
}
