import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { ChannelsModule } from 'src/channels/channels.module';
import { ResolveController } from './resolve.controller';

@Module({
  imports: [AuthModule, ChannelsModule],
  controllers: [ResolveController],
})
export class ResolveModule {}
