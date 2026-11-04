import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis';
import { AppLogger } from './logger';

@Global()
@Module({
  providers: [PrismaService, RedisService, AppLogger],
  exports: [PrismaService, RedisService, AppLogger],
})
export class SharedModule {}
