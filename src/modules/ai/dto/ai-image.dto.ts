import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GenerateProductImageDto {
  @ApiProperty({
    example: 'Blue cotton T-shirt',
    description: 'Product name used to build the image prompt',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: 'crew neck, soft fabric, retail packshot',
    description: 'Optional extra detail for the AI prompt',
  })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  hint?: string;
}
