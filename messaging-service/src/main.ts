import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger' 

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService)
  const port = config.get<number>('app.port')
  const nodeEnv = config.get<string>('app.nodeEnv')

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  )

  app.setGlobalPrefix("api/v1")

  if (nodeEnv === 'development') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Conduit Messaging Service')
      .setDescription('Microservicio de mensajeria personalizada multi-canal')
      .setVersion('1.0')
      .addApiKey({type: 'apiKey', name: 'x-api-key', in: 'header'}, 'api-key')
      .build()
  }



  await app.listen(process.env.PORT ?? 4123);
}
bootstrap();
