import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { ToolSpec } from '../ai/interface/AiProvider';
import { BotConfigService } from '../config/BotConfigService';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { CreateToolDefinitionDto } from './dto/create-tool-definition.dto';
import { UpdateToolDefinitionDto } from './dto/update-tool-definition.dto';
import { Prisma } from '@prisma/client';
import { stripSchemaPath } from './json-path.util';

export interface ResolvedTool {
  spec: ToolSpec;
  definitionId: string;
  requiresImageAttachment: boolean;
  imageParamName: string | null;
  maxImageSizeBytes: number | null;
  injectPhoneParamName: string | null;
  pausesBotMinutes: number | null;
}

@Injectable()
export class ToolDefinitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly botConfigService: BotConfigService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async list(botConfigId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    return this.prisma.toolDefinition.findMany({
      where: { botConfigId },
      select: this.safeSelect(),
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    botConfigId: string,
    tenantId: string,
    dto: CreateToolDefinitionDto,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    this.validate(dto);

    return this.prisma.toolDefinition.create({
      data: {
        botConfigId,
        name: dto.name,
        description: dto.description,
        parametersSchema: dto.parametersSchema as Prisma.InputJsonValue,
        endpointUrl: dto.endpointUrl,
        httpMethod: dto.httpMethod ?? 'POST',
        authHeaderName: dto.authHeaderName,
        authSecretEncrypted: dto.authSecret
          ? this.encryption.encrypt(dto.authSecret)
          : undefined,
        isActive: dto.isActive ?? true,
        requiresImageAttachment: dto.requiresImageAttachment ?? false,
        imageParamName: dto.imageParamName,
        maxImageSizeBytes: dto.maxImageSizeBytes,
        injectPhoneParamName: dto.injectPhoneParamName,
        pausesBotMinutes: dto.pausesBotMinutes,
      },
      select: this.safeSelect(),
    });
  }

  async update(
    botConfigId: string,
    toolId: string,
    tenantId: string,
    dto: UpdateToolDefinitionDto,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const existing = await this.prisma.toolDefinition.findFirst({
      where: { id: toolId, botConfigId },
    });
    if (!existing) throw new NotFoundException('Tool no encontrada.');
    this.validate(dto, true);

    const { clearAuth, authSecret, parametersSchema, ...changes } = dto;

    return this.prisma.toolDefinition.update({
      where: { id: toolId },
      data: {
        ...changes,

        ...(parametersSchema !== undefined
          ? {
              parametersSchema: parametersSchema as Prisma.InputJsonValue,
            }
          : {}),

        ...(authSecret
          ? {
              authSecretEncrypted: this.encryption.encrypt(authSecret),
            }
          : {}),

        ...(clearAuth
          ? {
              authHeaderName: null,
              authSecretEncrypted: null,
            }
          : {}),
      },
      select: this.safeSelect(),
    });
  }

  async remove(botConfigId: string, toolId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const { count } = await this.prisma.toolDefinition.deleteMany({
      where: { id: toolId, botConfigId },
    });
    if (!count) throw new NotFoundException('Tool no encontrada.');
  }

  async getActiveToolsForBot(botConfigId: string): Promise<ResolvedTool[]> {
    const defs = await this.prisma.toolDefinition.findMany({
      where: { botConfigId, isActive: true },
    });

    return defs.map((d) => {
      const fullSchema = d.parametersSchema as Record<string, any>;
      const fieldsToStrip: string[] = [];
      if (d.requiresImageAttachment) {
        fieldsToStrip.push(d.imageParamName ?? 'imageBase64');
      }
      if (d.injectPhoneParamName) {
        fieldsToStrip.push(d.injectPhoneParamName);
      }
      const exposedSchema =
        fieldsToStrip.length > 0
          ? this.stripFields(fullSchema, fieldsToStrip)
          : fullSchema;
      return {
        definitionId: d.id,
        spec: {
          name: d.name,
          description: d.description,
          parametersSchema: exposedSchema,
        },
        requiresImageAttachment: d.requiresImageAttachment,
        imageParamName: d.imageParamName,
        maxImageSizeBytes: d.maxImageSizeBytes,
        injectPhoneParamName: d.injectPhoneParamName,
        pausesBotMinutes: d.pausesBotMinutes,
      };
    });
  }

  private stripFields(
    schema: Record<string, any>,
    fieldNames: string[],
  ): Record<string, any> {
    return fieldNames.reduce(
      (current, field) => stripSchemaPath(current, field),
      schema,
    );
  }

  private validate(
    dto: Partial<CreateToolDefinitionDto>,
    isUpdate = false,
  ): void {
    if (!isUpdate && !dto.parametersSchema) {
      throw new BadRequestException('parametersSchema es obligatorio.');
    }
    if (dto.parametersSchema && dto.parametersSchema.type !== 'object') {
      throw new BadRequestException(
        'parametersSchema debe ser un JSON Schema de tipo object.',
      );
    }
    if (dto.authSecret && !dto.authHeaderName && !isUpdate) {
      throw new BadRequestException(
        'authHeaderName es obligatorio cuando se configura authSecret.',
      );
    }
  }

  private safeSelect() {
    return {
      id: true,
      botConfigId: true,
      name: true,
      description: true,
      parametersSchema: true,
      endpointUrl: true,
      httpMethod: true,
      authHeaderName: true,
      isActive: true,
      requiresImageAttachment: true,
      imageParamName: true,
      maxImageSizeBytes: true,
      injectPhoneParamName: true,
      pausesBotMinutes: true,
      createdAt: true,
      updatedAt: true,
    };
  }
}
