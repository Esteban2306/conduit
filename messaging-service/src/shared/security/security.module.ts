import { Module } from '@nestjs/common';
import { SecretEncryptionService } from './secret-encryption.service';
import { JwtGuard } from 'src/auth/guards/jwt-auth.guard';
import { ApiKeyGuard } from 'src/auth/api/ApiKeyGuard';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [JwtGuard, ApiKeyGuard, ApiAuthGuard, SecretEncryptionService],
  exports: [JwtGuard, ApiKeyGuard, ApiAuthGuard, SecretEncryptionService],
})
export class SecurityModule {}
