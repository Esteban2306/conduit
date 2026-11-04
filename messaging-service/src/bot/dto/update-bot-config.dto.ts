import { PartialType } from '@nestjs/swagger';
import { CreateBotConfigDto } from './create-bot-config.dto';

/**
 * `Partial<CreateBotConfigDto>` (tipo genérico) no lo valida el
 * ValidationPipe; PartialType conserva los validadores como opcionales.
 */
export class UpdateBotConfigDto extends PartialType(CreateBotConfigDto) {}
