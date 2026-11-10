import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from 'src/shared/filters/global-exception.filter';

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/v1/x', method: 'POST' }),
    }),
  };
  const filter = new GlobalExceptionFilter();
  (filter as unknown as { logger: object }).logger = {
    warn: jest.fn(),
    error: jest.fn(),
  };
  filter.catch(exception, host as never);
  return {
    code: (status.mock.calls[0] as unknown as [number])[0],
    body: (json.mock.calls[0] as unknown as [Record<string, unknown>])[0],
  };
}

describe('GlobalExceptionFilter: details', () => {
  it('reenvía details cuando la excepción lo trae', () => {
    const { code, body } = run(
      new BadRequestException({
        message: 'Datos inválidos',
        details: { issues: [{ path: 'name', message: 'requerido' }] },
      }),
    );
    expect(code).toBe(400);
    expect(body.details).toEqual({
      issues: [{ path: 'name', message: 'requerido' }],
    });
    expect(body.message).toBe('Datos inválidos');
  });

  it('reenvía details en un 409', () => {
    const { body } = run(
      new ConflictException({ message: 'x', details: { currentVersion: 3 } }),
    );
    expect(body.details).toEqual({ currentVersion: 3 });
  });

  it('sin details la respuesta es la de siempre', () => {
    const { body } = run(new BadRequestException('simple'));
    expect(body).not.toHaveProperty('details');
    expect(body).toMatchObject({ statusCode: 400, message: 'simple' });
  });

  it('solo reenvía la clave details: otras claves siguen sin salir', () => {
    const { body } = run(
      new BadRequestException({
        message: 'm',
        issues: ['no salgo'],
        secret: 'no salgo',
      }),
    );
    expect(JSON.stringify(body)).not.toContain('no salgo');
  });

  it('nunca reenvía details en un error de servidor', () => {
    const { code, body } = run(
      new InternalServerErrorException({
        message: 'fallo',
        details: { stack: 'interno' },
      }),
    );
    expect(code).toBe(500);
    expect(body).not.toHaveProperty('details');
  });

  it('un error de Prisma o desconocido no filtra detalles', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError('boom', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(run(prismaError).body).not.toHaveProperty('details');
    expect(run(new Error('interno secreto')).body.message).toBe(
      'Error interno del servidor.',
    );
  });

  it('una excepción con payload de texto no cambia', () => {
    const { body } = run(new HttpException('texto', 418));
    expect(body).toMatchObject({ statusCode: 418, message: 'texto' });
    expect(body).not.toHaveProperty('details');
  });
});
