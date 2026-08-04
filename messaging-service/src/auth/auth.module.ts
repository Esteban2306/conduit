import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { JwtGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategie';
import { Module } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { ApiKeyService } from './api/ApiKeyService';
import { ApiKeyGuard } from './api/ApiKeyGuard';
import { ApiAuthGuard } from './guards/api-auth.guard';
import { ApiKeyController } from './api-key.controller';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
    }),
  ],
  controllers: [AuthController, ApiKeyController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtGuard,
    ApiKeyService,
    ApiKeyGuard,
    ApiAuthGuard,
    PrismaService,
  ],
  exports: [AuthService, ApiKeyService, JwtGuard, ApiKeyGuard, ApiAuthGuard],
})
export class AuthModule {}
