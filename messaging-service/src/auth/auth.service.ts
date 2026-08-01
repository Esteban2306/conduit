import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/shared/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './types/jwt.types';
import { BotStatus, PromptTemplateType, UserRole } from '@prisma/client';
import { createHash } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  private signAccessToken(payload: JwtPayload) {
    return this.jwtService.sign(
      { ...payload, type: 'access' },
      { expiresIn: '1h' },
    );
  }

  private signRefreshToken(payload: JwtPayload) {
    return this.jwtService.sign(
      { ...payload, type: 'refresh' },
      { expiresIn: '7d' },
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async register(dto: RegisterDto) {
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.companySlug },
    });
    if (existingTenant) {
      throw new ConflictException(
        `El slug "${dto.companySlug}" ya está en uso`,
      );
    }

    const hashedPassword = await bcrypt.hash(dto.ownerPassword, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.companyName,
          slug: dto.companySlug,
          isActive: true,
        },
      });

      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.ownerEmail,
          password: hashedPassword,
          name: dto.ownerName,
          role: UserRole.OWNER,
          isActive: true,
        },
      });

      const botConfig = await tx.botConfig.create({
        data: {
          tenantId: tenant.id,
          name: `Bot de ${dto.companyName}`,
          status: BotStatus.INACTIVE,
          systemPrompt: '',
          imageAnalysisEnabled: false,
        },
      });

      await tx.botAiSettings.create({
        data: {
          botConfigId: botConfig.id,
          agentName: 'Asistente',
          language: 'es',
          tone: 'profesional y amable',
        },
      });

      await tx.botPromptTemplate.create({
        data: {
          botConfigId: botConfig.id,
          type: PromptTemplateType.CONVERSATION,
          content: `Eres {{agentName}}, asistente virtual de {{companyName}}.\nIdioma: {{language}}. Tono: {{tone}}.\n{{#restrictions}}Restricciones: {{restrictions}}\n{{/restrictions}}Responde de forma {{responseLength}}. {{emojiInstruction}}`,
          isActive: true,
          version: 1,
        },
      });

      return { tenant, owner, botConfig };
    });

    return {
      tenantId: result.tenant.id,
      tenantSlug: result.tenant.slug,
      userId: result.owner.id,
      email: result.owner.email,
      name: result.owner.name,
      role: result.owner.role,
      botConfigId: result.botConfig.id,
    };
  }

  async login(dto: LoginDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
    });
    if (!tenant || !tenant.isActive) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

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

    const accessToken = this.signAccessToken(payload);
    const refreshToken = this.signRefreshToken(payload);

    const decoded = this.jwtService.decode(refreshToken) as { exp: number };
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(decoded.exp * 1000),
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
      },
      accessToken,
      refreshToken,
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

  async refresh(refreshToken: string): Promise<string> {
    let payload: JwtPayload & { type?: string };

    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException();
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException();
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      include: { user: { include: { tenant: true } } },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException();
    }

    if (!stored.user.isActive || !stored.user.tenant.isActive) {
      throw new UnauthorizedException();
    }

    return this.signAccessToken({
      sub: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    });
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;

    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
