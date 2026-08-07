import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateDocumentDto {
  @ApiPropertyOptional({ enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  /** @deprecated use type */
  @ApiPropertyOptional({ enum: DocumentType })
  @ValidateIf((o: CreateDocumentDto) => !o.type)
  @IsEnum(DocumentType)
  docType?: DocumentType;

  @ApiProperty({
    example: 'tenants/abc/documents/agreement-0001.pdf',
    description: 'Storage path/key',
  })
  @IsString()
  @MaxLength(1000)
  storageKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Stored in document.meta' })
  @IsOptional()
  @IsUUID()
  returnEventId?: string;
}

export class ListDocumentsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
