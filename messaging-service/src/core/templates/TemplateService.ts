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
import { Prisma } from '@prisma/client';
import { FilterTemplateDto } from './dto/filter-template.dto';
import { PreviewTemplateDto } from './dto/preview-template.dto';

@Injectable()
export class TemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: TemplateEngine,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  async create(tenantId: string, dto: CreateTemplateDto) {
    this.validateHandlebarsSyntax(dto.bodyHandlebars);

    if (dto.subject) this.validateHandlebarsSyntax(dto.subject);

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
      include: {
        tags: { include: { tag: true } },
      },
    });
  }

  async findAll(tenantId: string, filter: FilterTemplateDto) {
    const where: Prisma.TemplateWhereInput = { tenantId, isActive: true };

    if (filter.channel) {
      where.channel = filter.channel;
    }

    if (filter.tagId) {
      where.tags = {
        some: {
          tagId: filter.tagId,
        },
      };
    }

    if (filter.search) {
      const search = filter.search.trim();

      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },

        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = ((filter.page ?? 1) - 1) * (filter.limit ?? 20);

    const take = filter.limit ?? 20;

    const [templates, total] = await Promise.all([
      this.prisma.template.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          tags: { include: { tag: true } },
        },
      }),

      this.prisma.template.count({ where }),
    ]);

    return {
      data: templates.map((t) => ({
        ...t,
        tags: t.tags.map((tt) => tt.tag),
      })),

      meta: {
        total,
        page: filter.page ?? 1,
        limit: filter.limit ?? 20,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async findOne(id: string, tenantId: string) {
    const template = await this.prisma.template.findUnique({
      where: { id: id, tenantId },
      include: {
        tags: { include: { tag: true } },
      },
    });
    if (!template) throw new NotFoundException(`Template ${id} no encontrado`);
    return {
      ...template,

      tags: template.tags.map((tt) => tt.tag),
    };
  }

  async update(id: string, dto: UpdateTemplateDto, tenantId: string) {
    await this.findOne(id, tenantId);

    if (dto.bodyHandlebars) {
      this.validateHandlebarsSyntax(dto.bodyHandlebars);
    }

    if (dto.subject) {
      this.validateHandlebarsSyntax(dto.subject);
    }

    return this.prisma.template.update({
      where: { id },
      data: { ...dto },
      include: {
        tags: { include: { tag: true } },
      },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);

    return this.prisma.template.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async preview(id: string, dto: PreviewTemplateDto, tenantId: string) {
    const template = await this.findOne(id, tenantId);

    const detectedVariables = this.engine.extractVariables(
      template.bodyHandlebars,
    );

    const validation = this.engine.validateVariables(
      template.bodyHandlebars,

      dto.variables,
    );

    if (!validation.valid) {
      throw new BadRequestException(
        `Variables faltantes: ${validation.missing.join(', ')}`,
      );
    }

    const rendered = this.engine.renderByChannel(
      template.channel,

      template.bodyHandlebars,

      dto.variables,

      dto.subject ?? template.subject ?? undefined,
    );

    const usedVariables = this.getUsedVariables(
      dto.variables,

      detectedVariables,
    );

    return {
      templateId: template.id,

      templateName: template.name,

      channel: template.channel,

      detectedVariables,

      providedVariables: usedVariables,

      rendered,

      preview: {
        html: rendered.body,

        plainText: this.stripHtml(rendered.body),

        subject: rendered.subject,

        whatsappPreview: this.formatWhatsappPreview(rendered.body),
      },
    };
  }

  private validateHandlebarsSyntax(template: string) {
    try {
      this.engine.render(template, {});
    } catch {
      throw new BadRequestException(
        'El bodyHandlebars contiene sintaxis invalida',
      );
    }
  }

  private getUsedVariables(
    provided: Record<string, unknown>,

    detected: string[],
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(provided).filter(([key]) => detected.includes(key)),
    );
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  private formatWhatsappPreview(text: string): string {
    const plain = this.stripHtml(text);

    const truncated =
      plain.length > 1024 ? plain.slice(0, 1021) + '...' : plain;

    return truncated;
  }
}
