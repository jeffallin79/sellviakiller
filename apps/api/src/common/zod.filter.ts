import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/** Request-body validation failures are the caller's fault: 400 with readable messages, not 500. */
@Catch(ZodError)
export class ZodValidationFilter implements ExceptionFilter {
  catch(e: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const issues = e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    res.status(400).json({
      statusCode: 400,
      message: issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
      issues,
    });
  }
}
