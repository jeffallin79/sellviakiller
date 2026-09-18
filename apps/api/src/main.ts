import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';
import { auth } from './auth/better-auth';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const expressApp = app.getHttpAdapter().getInstance();

  expressApp.use(cookieParser());
  app.enableCors({
    origin: (process.env.TRUSTED_ORIGINS ?? 'http://localhost:3000,http://localhost:3001')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
  });

  const betterAuthHandler = toNodeHandler(auth);
  // Full-path mount so Better Auth basePath /api/auth matches
  expressApp.all('/api/auth/*', (req: Request, res: Response, next: () => void) => {
    if (req.method === 'POST' && req.path === '/api/auth/bootstrap') return next();
    return betterAuthHandler(req, res);
  });

  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('StoreForge API')
    .setDescription('Phase 0 MVP — Square payments, multi-tenant stores, supplier adapters')
    .setVersion('0.1.0')
    .addCookieAuth('better-auth.session_token')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`StoreForge API listening on http://localhost:${port}`);
  console.log(`OpenAPI docs: http://localhost:${port}/docs`);
}

bootstrap();
