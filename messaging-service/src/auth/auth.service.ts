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
