import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message, error } = this.resolveException(exception);

    const body: ErrorResponseBody = {
      statusCode,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    this.log(statusCode, request, exception, body);

    response.status(statusCode).json(body);
  }

  private resolveException(exception: unknown): {
    statusCode: number;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return { statusCode: status, message: payload, error: exception.name };
      }

      const payloadObj = payload as {
        message?: string | string[];
        error?: string;
      };

      return {
        statusCode: status,
        message: payloadObj.message ?? exception.message,
        error: payloadObj.error ?? exception.name,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrismaError(exception);
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Error interno del servidor.',
      error: 'InternalServerError',
    };
  }

  private resolvePrismaError(exception: Prisma.PrismaClientKnownRequestError): {
    statusCode: number;
    message: string;
    error: string;
  } {
    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'Ya existe un registro con esos datos únicos.',
          error: 'Conflict',
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Registro no encontrado.',
          error: 'NotFound',
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Error interno del servidor.',
          error: 'InternalServerError',
        };
    }
  }

  private log(
    statusCode: number,
    request: Request,
    exception: unknown,
    body: ErrorResponseBody,
  ): void {
    const context = `${request.method} ${request.url}`;

    if (statusCode >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`${context} → ${statusCode} | ${body.message}`, stack);
      return;
    }

    if (statusCode >= 400) {
      this.logger.warn(`${context} → ${statusCode} | ${body.message}`);
    }
  }
}
