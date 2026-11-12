import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CartCaptureSchema } from '@storeforge/shared';
import { CartsService } from './carts.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';

const SettingsSchema = z.object({ enabled: z.boolean().optional(), mailingAddress: z.string().max(300).nullable().optional() });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f6f1e7;color:#1f1a17;font:16px/1.55 'Instrument Sans','Helvetica Neue',Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:#fffdf8;border:2px solid #e4dccd;border-radius:18px;padding:32px 28px;max-width:440px;width:100%}h1{font:800 26px/1.15 'Bricolage Grotesque','Helvetica Neue',Arial,sans-serif;margin:0 0 10px;letter-spacing:-.02em}
p{margin:0 0 12px}button{font:700 15px/1 inherit;font-family:inherit;background:#7a1f2b;color:#fff;border:0;border-radius:12px;padding:13px 20px;cursor:pointer;box-shadow:0 3px 0 #1f1a17}
button:focus-visible{outline:3px solid #e2a63b;outline-offset:2px}.muted{color:#6a5f57;font-size:14px}</style></head><body><main>${body}</main></body></html>`;
}

@ApiTags('carts')
@Controller()
export class CartsController {
  constructor(private readonly carts: CartsService, private readonly auth: AuthService) {}

  /** Storefront: save the bag for reminders (only with consent + email; consent:false scrubs). */
  @Post('storefront/carts')
  @HttpCode(200)
  capture(@Body() body: unknown, @Req() req: Request) {
    const input = CartCaptureSchema.parse(body);
    const ipHeader = req.headers['x-sf-client-ip'];
    const ip = typeof ipHeader === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(ipHeader) ? ipHeader : req.ip ?? 'unknown';
    return this.carts.capture(input, ip);
  }

  /** Storefront: recovery link → lines to restore. */
  @Get('storefront/carts/recover')
  recover(@Query('id') id: string, @Query('t') t: string) {
    return this.carts.recover(String(id ?? '').slice(0, 64), String(t ?? '').slice(0, 64));
  }

  /** Unsubscribe page (link in every reminder). GET only shows a button: link scanners can't unsubscribe people. */
  @Get('email/unsubscribe')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', CSP)
  @Header('Cache-Control', 'no-store')
  async unsubscribePage(@Query('s') s: string, @Query('e') e: string, @Query('t') t: string) {
    const info = await this.carts.unsubscribeInfo(String(s ?? ''), String(e ?? ''), String(t ?? ''));
    if (!info.valid) return page('Link not valid', `<h1>This link isn't valid.</h1><p>It may have been cut off by your email app. Reply to any email from the shop and ask them to stop, and they will.</p>`);
    if (info.done) return page('Unsubscribed', `<h1>You're unsubscribed.</h1><p>${esc(info.store)} won't send you bag reminders again.</p><p class="muted">Emails about orders you place (receipts, tracking) still come, because they're about your purchase.</p>`);
    const q = `s=${encodeURIComponent(s)}&e=${encodeURIComponent(e)}&t=${encodeURIComponent(t)}`;
    return page('Unsubscribe', `<h1>Stop bag reminders from ${esc(info.store)}?</h1><p>You'll stop getting "you left something in your bag" emails from this shop.</p><form method="post" action="/api/email/unsubscribe?${esc(q)}"><button type="submit">Unsubscribe</button></form><p class="muted" style="margin-top:14px">Order receipts and tracking emails are not affected.</p>`);
  }

  /** Form button and RFC 8058 one-click (body List-Unsubscribe=One-Click). Idempotent. */
  @Post('email/unsubscribe')
  @HttpCode(200)
  async unsubscribe(@Query('s') s: string, @Query('e') e: string, @Query('t') t: string, @Body() body: any, @Res() res: Response) {
    const oneClick = body && typeof body === 'object' && body['List-Unsubscribe'] === 'One-Click';
    try {
      const r = await this.carts.unsubscribe(String(s ?? ''), String(e ?? ''), String(t ?? ''), oneClick ? 'one_click' : 'unsubscribe');
      if (oneClick) return res.status(200).type('text/plain').send('unsubscribed');
      res.setHeader('Content-Security-Policy', CSP);
      return res.status(200).type('html').send(page('Unsubscribed', `<h1>You're unsubscribed.</h1><p>${esc(r.store)} won't send you bag reminders again.</p><p class="muted">Emails about orders you place (receipts, tracking) still come, because they're about your purchase.</p>`));
    } catch {
      if (oneClick) return res.status(400).type('text/plain').send('invalid link');
      res.setHeader('Content-Security-Policy', CSP);
      return res.status(400).type('html').send(page('Link not valid', `<h1>This link isn't valid.</h1><p>Reply to any email from the shop and ask them to stop, and they will.</p>`));
    }
  }

  // ---------------- merchant ----------------

  @Get('stores/:id/cart-recovery')
  @UseGuards(AuthGuard)
  async overview(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.carts.overview(await this.auth.requireAccountId(user.id), id);
  }

  @Patch('stores/:id/cart-recovery')
  @UseGuards(AuthGuard)
  async settings(@CurrentUser() user: { id: string }, @Param('id') id: string, @Body() body: unknown) {
    return this.carts.updateSettings(await this.auth.requireAccountId(user.id), id, SettingsSchema.parse(body));
  }
}
