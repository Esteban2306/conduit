import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppConnectionStatus, WhatsAppWarmupLevel } from '@prisma/client';
import { WhatsAppConnectionService } from './WhatsAppConnection.service';
import { BaileysSessionManager } from './baileys/BaileysSessionManager';
import { CreateWhatsAppConnectionDto } from './dto/create-whatsapp-connection.dto';
import { BaileysRateLimiterRegistry } from './baileys/BaileysRateLimiterRegistry';
import { WarmupLevel } from './baileys/BaileysRateLimiter';

@Injectable()
export class WhatsAppConnectionOrchestrator {
  private readonly logger = new Logger(WhatsAppConnectionOrchestrator.name);

  constructor(
    private readonly connections: WhatsAppConnectionService,
    private readonly sessionManager: BaileysSessionManager,
    private readonly limiters: BaileysRateLimiterRegistry,
  ) {}

  async createAndStart(tenantId: string, dto: CreateWhatsAppConnectionDto) {
    const connection = await this.connections.create(tenantId, dto);
    await this.startWithRollback(connection.id, tenantId);
    return this.connections.findOne(connection.id, tenantId);
  }

  async assignBotConfig(id: string, tenantId: string, botConfigId: string) {
    const connection = await this.connections.assignBotConfig(
      id,
      tenantId,
      botConfigId,
    );
    this.sessionManager.refreshBotConfigId(id, botConfigId);
    return connection;
  }

  async unassignBotConfig(id: string, tenantId: string) {
    const connection = await this.connections.unassignBotConfig(id, tenantId);
    this.sessionManager.refreshBotConfigId(id, null);
    return connection;
  }

  async connect(id: string, tenantId: string) {
    await this.connections.connect(id, tenantId);
    await this.startWithRollback(id, tenantId);
    return this.connections.findOne(id, tenantId);
  }

  async disconnect(id: string, tenantId: string) {
    await this.connections.findOne(id, tenantId);
    await this.sessionManager.stop(id);
    return this.connections.disconnect(id, tenantId);
  }

  async reconnect(id: string, tenantId: string) {
    await this.connections.restart(id, tenantId);
    try {
      await this.sessionManager.reconnect(id);
    } catch (error) {
      await this.markErrorSafely(id, tenantId, error);
      throw error;
    }
    return this.connections.findOne(id, tenantId);
  }

  async updateWarmupLevel(
    id: string,
    tenantId: string,
    warmupLevel: WhatsAppWarmupLevel,
  ) {
    const connection = await this.connections.updateWarmupLevel(
      id,
      tenantId,
      warmupLevel,
    );
    this.limiters.updateWarmupLevel(id, warmupLevel as unknown as WarmupLevel);
    return connection;
  }

  async remove(id: string, tenantId: string) {
    await this.connections.findOne(id, tenantId);
    await this.sessionManager.stop(id);
    await this.connections.delete(id, tenantId);
    return { id, deleted: true };
  }

  private async startWithRollback(id: string, tenantId: string): Promise<void> {
    try {
      await this.sessionManager.start(id);
    } catch (error) {
      await this.markErrorSafely(id, tenantId, error);
      throw error;
    }
  }

  private async markErrorSafely(
    id: string,
    tenantId: string,
    error: unknown,
  ): Promise<void> {
    this.logger.error(
      `Fallo al iniciar sesión de WhatsApp ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await this.connections
      .updateStatus(id, WhatsAppConnectionStatus.ERROR)
      .catch((rollbackError) => {
        this.logger.error(
          `No fue posible marcar ERROR la conexión ${id}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      });
  }
}
