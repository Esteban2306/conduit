import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { JwtGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategie';
import { Module } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtGuard, PrismaService],
  exports: [AuthService],
})
export class AuthModule {}
