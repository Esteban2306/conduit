import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from 'src/api/middlewares/auth';
import type { JwtPayload } from './types/jwt.types';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';

const COOKIE_OPTS = {
  httpOnly: true,
  // En producción las cookies de sesión solo viajan por HTTPS.
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * El registro crea un tenant nuevo con acceso a WhatsApp y a las claves
   * de IA por defecto del servidor. Cerrado salvo que se habilite
   * explícitamente o se presente el token de registro.
   */
  @Public()
  @Throttle({ short: { limit: 3, ttl: 60_000 } })
  @Post('register')
  register(
    @Body() dto: RegisterDto,
    @Headers('x-registration-token') registrationToken?: string,
  ) {
    this.assertRegistrationAllowed(registrationToken);
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ short: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } =
      await this.authService.login(dto);

    res.cookie('accessToken', accessToken, {
      ...COOKIE_OPTS,
      maxAge: 1000 * 60 * 60,
    });
    res.cookie('refreshToken', refreshToken, {
      ...COOKIE_OPTS,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });

    return user;
  }

  @UseGuards(JwtGuard)
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.getMe(user.sub, user.tenantId);
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.refreshToken;
    if (!token) throw new UnauthorizedException();

    const accessToken = await this.authService.refresh(token);
    res.cookie('accessToken', accessToken, {
      ...COOKIE_OPTS,
      maxAge: 1000 * 60 * 60,
    });
    return { ok: true };
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.refreshToken);
    res.clearCookie('accessToken', COOKIE_OPTS);
    res.clearCookie('refreshToken', COOKIE_OPTS);
    return { ok: true };
  }

  private assertRegistrationAllowed(provided?: string): void {
    if (this.config.get<boolean>('auth.allowPublicRegistration')) return;

    const expected = this.config.get<string>('auth.registrationToken');
    if (expected && provided) {
      const a = createHash('sha256').update(provided).digest();
      const b = createHash('sha256').update(expected).digest();
      if (timingSafeEqual(a, b)) return;
    }

    throw new ForbiddenException(
      'El registro de nuevas empresas está deshabilitado en este servidor.',
    );
  }
}
