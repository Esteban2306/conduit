import { Module } from '@nestjs/common';
import { SecretEncryptionService } from './secret-encryption.service';

@Module({
  providers: [SecretEncryptionService],
  exports: [SecretEncryptionService],
})
export class SecurityModule {}
