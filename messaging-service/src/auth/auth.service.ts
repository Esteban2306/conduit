import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/shared/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './types/jwt.types';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  private signAccessToken(payload: JwtPayload) {
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  private signRefreshToken(payload: JwtPayload) {
    return this.jwtService.sign(payload, { expiresIn: '7d' });
  }

  async register(dto: RegisterDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
    });
    if (!tenant) throw new NotFoundException('Tenant no encontrado');

    const exists = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email } },
    });
    if (exists)
      throw new UnprocessableEntityException(
        'El email ya está registrado en este tenant',
      );

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: dto.email,
        password: hashed,
        name: dto.name,
      },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    };
  }

  async login(dto: LoginDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
    });
    if (!tenant) throw new UnauthorizedException('Credenciales inválidas');

    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email } },
    });
    if (!user || !user.isActive)
      throw new UnauthorizedException('Credenciales inválidas');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Credenciales inválidas');

    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
    };

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantSlug: tenant.slug,
      },
      accessToken: this.signAccessToken(payload),
      refreshToken: this.signRefreshToken(payload),
    };
  }

  async getMe(userId: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true, name: true, role: true, tenantId: true },
    });
    if (!user) throw new UnauthorizedException();

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, name: true },
    });

    return { ...user, tenantSlug: tenant?.slug, tenantName: tenant?.name };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken);
      return this.signAccessToken({
        sub: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
      });
    } catch {
      throw new UnauthorizedException();
    }
  }
}
