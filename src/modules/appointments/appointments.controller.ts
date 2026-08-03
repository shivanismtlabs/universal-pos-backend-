import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { AppointmentsService } from './appointments.service';
import {
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  UpdateAppointmentDto,
} from './dto/appointments.dto';

@ApiTags('appointments')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.fittings)
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Schedule fitting / pickup / return appointment' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAppointmentDto) {
    return this.appointmentsService.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List appointments (filterable, paginated)' })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAppointmentsQueryDto,
  ) {
    return this.appointmentsService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get appointment by id' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.appointmentsService.getById(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update notes / assignee / time / status' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentDto,
  ) {
    return this.appointmentsService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel appointment (soft delete via status)' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.appointmentsService.remove(user, id);
  }
}
