import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { ArrayMaxSize, IsArray, IsString, IsEnum, IsOptional, IsBoolean, IsObject } from 'class-validator'
import { MessageChannel } from '@prisma/client';

export class CreateTemplateDto {
    @ApiProperty({example: 'Confirmacion de pedido'})
    @IsString()
    name: string;

    @ApiPropertyOptional({example: 'Se envia al cliente cuando su pedido es confirmado'})
    @IsString()
    @IsOptional()
    description?: string

    @ApiProperty({enum: MessageChannel, example: 'EMAIL'})
    @IsEnum(MessageChannel)
    channel: MessageChannel

    @ApiPropertyOptional({example: 'tu pedido #{{numeroPedido}} fue confirmado'})
    @IsString()
    @IsOptional()
    subject?: string

    @ApiProperty({
        example: '<h1>Hola {{nombreCliente}}</h1><p>Tu pedido #{{numeroPedido}} está listo.</p>'
    })
    @IsString()
    bodyHandlebars: string

    @ApiPropertyOptional({
        example: ['Hola {{nombreCliente}}, tu pedido #{{numeroPedido}} está listo.'],
        description: 'Hasta 3 redacciones alternativas con las mismas variables; cada mensaje usa una de forma estable.',
    })
    @IsArray()
    @ArrayMaxSize(3)
    @IsString({ each: true })
    @IsOptional()
    bodyVariants?: string[]

    @ApiPropertyOptional ({
        example: {nombreCliente: 'strign', numeroPedido: 'string', total: 'number'},
    })
    @IsObject()
    @IsOptional()
    variadblesSchema?: Record<string, unknown>
}