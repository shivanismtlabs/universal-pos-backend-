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
import {
  CreateSyncEventDto,
  ListSyncEventsQueryDto,
  ResolveSyncEventDto,
} from './dto/sync.dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.pos)
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('events')
  @ApiOperation({
    summary: 'Push an offline event (idempotent on clientEventId per tenant)',
  })
  createEvent(@CurrentUser() user: AuthUser, @Body() dto: CreateSyncEventDto) {
    return this.syncService.createEvent(user, dto);
  } 

  @Get('events')
  @ApiOperation({ summary: 'List synced offline events' })
  listEvents(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSyncEventsQueryDto,
  ) {
    return this.syncService.listEvents(user, query);
  }

  @Post('events/:id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve a sync event (accepted/conflict/rejected)',
  })
  resolveEvent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSyncEventDto,
  ) {
    return this.syncService.resolveEvent(user, id, dto);
  }
}
