import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import {
  isCorsOriginAllowed,
  resolveCorsAllowlist,
} from './common/cors-origins';
import { applyApiSecurityHeaders } from './common/http-security-headers';

async function bootstrap() {
  // bodyParser: false — we register JSON ourselves so empty bodies
  // (logout / DELETE) don't fail when Content-Type is application/json.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      bodyLimit: 6 * 1024 * 1024,
    }),
    { bodyParser: false },
  );

  const uploadsRoot = join(process.cwd(), 'uploads');
  mkdirSync(uploadsRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: '/v1/uploads/',
    decorateReply: false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as { rawBody?: Buffer }).rawBody = body as Buffer;
      if (!body || (body as Buffer).length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
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

  const corsAllowlist = resolveCorsAllowlist(process.env);
  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      callback(null, isCorsOriginAllowed(origin, corsAllowlist));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    preflight: true,
    strictPreflight: false,
    hook: 'onRequest',
  });

  app.enableCors({
    origin: (origin, callback) => {
      callback(null, isCorsOriginAllowed(origin, corsAllowlist));
    },
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

  fastify.addHook('onSend', (req, reply, _payload, done) => {
    applyApiSecurityHeaders(reply, req.url);
    done();
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Universal POS API')
    .setDescription(
      'Universal multi-tenant Rental & Sales POS API.\n\n' +
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
  fastify.setNotFoundHandler((request, reply) => {
    const origin = request.headers.origin;
    if (request.method === 'OPTIONS') {
      if (origin && isCorsOriginAllowed(origin, corsAllowlist)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header(
          'Access-Control-Allow-Methods',
          'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
        );
        reply.header(
          'Access-Control-Allow-Headers',
          String(
            request.headers['access-control-request-headers'] ??
              'Content-Type,Authorization,Accept,Origin,X-Requested-With',
          ),
        );
        reply.header('Access-Control-Max-Age', '86400');
        reply.header('Vary', 'Origin');
      }
      return reply.code(204).send();
    }
    return reply.code(404).send({
      success: false,
      statusCode: 404,
      error: 'Not Found',
      message: `Cannot ${request.method} ${request.url}`,
    });
  });
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
