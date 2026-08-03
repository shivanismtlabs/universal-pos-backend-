import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

export const S3 = Symbol('S3');

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: S3,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const endpoint = config.get<string>('S3_ENDPOINT');
        return new S3Client({
          region: config.get<string>('S3_REGION', 'ap-south-1'),
          endpoint: endpoint || undefined,
          forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
          credentials: {
            accessKeyId: config.get<string>('S3_ACCESS_KEY_ID', ''),
            secretAccessKey: config.get<string>('S3_SECRET_ACCESS_KEY', ''),
          },
        });
      },
    },
  ],
  exports: [S3],
})
export class StorageModule {}
