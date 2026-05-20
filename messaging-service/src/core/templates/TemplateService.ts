import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { TemplateEngine } from './TemplateEngine';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from 'src/config';

@Injectable()
export class TemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: TemplateEngine,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  async create(dto: CreateTemplateDto) {
    try {
      this.engine.render(dto.bodyHandlebars, {});
    } catch {
      throw new BadRequestException(
        'El bodyHandlebars contiene sintaxis invalida',
      );
    }

    const tenantId = this.config.get('tenant.defaultId', { infer: true });

    return this.prisma.template.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description ?? '',
        channel: dto.channel,
        subject: dto.subject,
        bodyHandlebars: dto.bodyHandlebars,
        variablesSchema: dto.variadblesSchema
          ? JSON.stringify(dto.variadblesSchema)
          : JSON.stringify({}),
      },
    });
  }

  async findAll() {
    return this.prisma.template.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw new NotFoundException(`Template ${id} no encontrado`);
    return template;
  }

  async update(id: string, dto: UpdateTemplateDto) {
    await this.findOne(id);

    if (dto.bodyHandlebars) {
      try {
        this.engine.render(dto.bodyHandlebars, {});
      } catch {
        throw new BadRequestException(
          'El bodyHandlebars contiene sintaxis invalida',
        );
      }
    }

    return this.prisma.template.update({
      where: { id },
      data: { ...dto },
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.template.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async preview(
    id: string,
    variables: Record<string, unknown>,
    subjectOverride?: string,
  ) {
    const template = await this.findOne(id);

    const validation = this.engine.validateVariables(
      template.bodyHandlebars,
      variables,
    );
    if (!validation.valid) {
      throw new BadRequestException(
        `Variables faltantes en la plantilla: ${validation.missing.join(', ')}`,
      );
    }

    const rendered = this.engine.render(
      template.bodyHandlebars,
      variables,
      subjectOverride ?? template.subject ?? undefined,
    );

    return {
      templateId: template.id,
      templateName: template.name,
      channel: template.channel,
      variables: this.engine.extractVariables(template.bodyHandlebars),
      rendered: {
        subject: rendered.subject,
        body: rendered.body,
      },
    };
  }
}
