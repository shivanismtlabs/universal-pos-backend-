import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto, ListDocumentsQueryDto } from './dto/documents.dto';

@ApiTags('documents')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.studio)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @ApiOperation({
    summary: 'Register a document (agreement / id proof / damage photo)',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDocumentDto) {
    return this.documentsService.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List documents, filterable by order/customer' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListDocumentsQueryDto) {
    return this.documentsService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get document by id' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documentsService.getById(user, id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer acknowledges / signs document' })
  acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documentsService.acknowledge(user, id);
  }
}
