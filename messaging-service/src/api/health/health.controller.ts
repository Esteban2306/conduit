import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from 'src/shared/prisma.service';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from 'src/config';

@ApiTags('Health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService<AppConfig>
    ) {}

    @Get()
    @ApiOperation({summary: 'Check the health of the microservice and its dependencises'})
    async cheak() {
        const dbStatus = await this.checkDatabase()
        const allHealthy = dbStatus.status === 'ok'

        return {
            status: allHealthy? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            environment: this.configService.get('app.nodeEnv', {infer: true}),
            version: process.env.npm_package_version ?? '1.0.0',
            service: {
                database: dbStatus
            }

        }
    }

    private async checkDatabase(): Promise<{status: string; latencyMs?: number, error?: string}> {
        const start = Date.now()
        try {
            await this.prisma.$queryRaw`SELECT 1`
            return {
                status: 'ok',
                latencyMs: Date.now() - start
            } 
        } catch (error ) {
            return {
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown database error'
            }
        }
    }
}   