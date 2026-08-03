import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  // bodyParser: false — we register JSON ourselves so empty bodies
  // (logout / DELETE) don't fail when Content-Type is application/json.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
    { bodyParser: false },
  );

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (body == null || body === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  const prefix = process.env.API_PREFIX ?? 'v1';
  app.setGlobalPrefix(prefix);
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Tuxedo POS API')
    .setDescription(
      'Tuxedo / formal-wear rental POS — multi-tenant SaaS API (FRD/BRD).\n\n' +
        '**Response envelope**\n' +
        '- Success: `{ success: true, data: <payload> }`\n' +
        '- Error: `{ success: false, statusCode, error, message, path, timestamp }`',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Paste accessToken from /auth/login or /auth/register-tenant',
      },
      'access-token',
    )
    .addTag('health')
    .addTag('auth')
    .addTag('tenants')
    .addTag('users')
    .addTag('customers')
    .addTag('inventory')
    .addTag('orders')
    .addTag('pos')
    .addTag('payments')
    .addTag('billing')
    .addTag('appointments')
    .addTag('returns')
    .addTag('documents')
    .addTag('notify')
    .addTag('sync')
    .addTag('reports')
    .addTag('platform')
    .addTag('platform-billing')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
