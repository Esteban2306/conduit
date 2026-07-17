import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from 'src/config';
import { PrismaService } from 'src/shared/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagService {
  constructor(
    private readonly prisma: PrismaService,

    private readonly config: ConfigService<AppConfig>,
  ) {}

  async create(dto: CreateTagDto, tenantId: string) {
    const existing = await this.prisma.tag.findFirst({
      where: { tenantId, slug: dto.slug },
    });

    if (existing) {
      throw new ConflictException(
        `Ya existe un tag con slug "${dto.slug}" para este tenant`,
      );
    }

    return this.prisma.tag.create({
      data: {
        tenantId,

        name: dto.name,

        slug: dto.slug,

        color: dto.color,
      },
    });
  }

  async findAll(tenantId: string) {
    return this.prisma.tag.findMany({
      where: { tenantId },

      orderBy: { name: 'asc' },

      include: {
        _count: {
          select: { templates: true },
        },
      },
    });
  }

  async findOne(id: string, tenantId: string) {
    const tag = await this.prisma.tag.findUnique({
      where: { id, tenantId },

      include: { _count: { select: { templates: true } } },
    });

    if (!tag) throw new NotFoundException(`Tag ${id} no encontrado`);

    return tag;
  }

  async update(id: string, dto: UpdateTagDto, tenantId: string) {
    await this.findOne(id, tenantId);

    if (dto.slug) {
      const conflict = await this.prisma.tag.findFirst({
        where: {
          tenantId,

          slug: dto.slug,

          NOT: { id },
        },
      });

      if (conflict) {
        throw new ConflictException(
          `Ya existe un tag con slug "${dto.slug}" para este tenant`,
        );
      }
    }

    return this.prisma.tag.update({
      where: { id },

      data: { ...dto },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);

    return this.prisma.tag.delete({ where: { id } });
  }

  async assignToTemplate(
    templateId: string,
    tagIds: string[],
    tenantId: string,
  ) {
    const template = await this.prisma.template.findUnique({
      where: { id: templateId, tenantId },
    });

    if (!template) {
      throw new NotFoundException(`Template ${templateId} no encontrado`);
    }

    const tags = await this.prisma.tag.findMany({
      where: { id: { in: tagIds } },
    });

    if (tags.length !== tagIds.length) {
      const found = new Set(tags.map((t) => t.id));

      const missing = tagIds.filter((id) => !found.has(id));

      throw new NotFoundException(`Tags no encontrados: ${missing.join(', ')}`);
    }

    await this.prisma.templateTag.createMany({
      data: tagIds.map((tagId) => ({
        templateId,

        tagId,
      })),

      skipDuplicates: true,
    });

    return this.getTemplateWithTags(templateId);
  }

  async unassignFromTemplate(templateId: string, tagIds: string[]) {
    await this.prisma.templateTag.deleteMany({
      where: {
        templateId,

        tagId: { in: tagIds },
      },
    });

    return this.getTemplateWithTags(templateId);
  }

  async replaceTagsForTemplate(
    templateId: string,

    tagIds: string[],
  ) {
    const template = await this.prisma.template.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException(`Template ${templateId} no encontrado`);
    }

    await this.prisma.$transaction([
      this.prisma.templateTag.deleteMany({
        where: { templateId },
      }),

      ...(tagIds.length > 0
        ? [
            this.prisma.templateTag.createMany({
              data: tagIds.map((tagId) => ({
                templateId,

                tagId,
              })),
            }),
          ]
        : []),
    ]);

    return this.getTemplateWithTags(templateId);
  }

  private async getTemplateWithTags(templateId: string) {
    return this.prisma.template.findUnique({
      where: { id: templateId },

      include: {
        tags: {
          include: { tag: true },
        },
      },
    });
  }
}
