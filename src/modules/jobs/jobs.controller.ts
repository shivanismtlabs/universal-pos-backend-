import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateWorkAssetDto,
  CreateWorkJobDto,
  ListWorkAssetsQueryDto,
  ListWorkJobsQueryDto,
  UpdateWorkJobDto,
} from './dto/jobs.dto';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@ApiBearerAuth('access-token')
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('assets')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Register a customer asset (device/vehicle/…)' })
  createAsset(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkAssetDto) {
    return this.jobs.createAsset(user, dto);
  }

  @Get('assets')
  @Roles(...RoleGroup.all)
  listAssets(
    @CurrentUser() user: AuthUser,
    @Query() query: ListWorkAssetsQueryDto,
  ) {
    return this.jobs.listAssets(user, query);
  }

  @Post('jobs')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Create a work / repair job' })
  createJob(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkJobDto) {
    return this.jobs.createJob(user, dto);
  }

  @Get('jobs')
  @Roles(...RoleGroup.all)
  listJobs(@CurrentUser() user: AuthUser, @Query() query: ListWorkJobsQueryDto) {
    return this.jobs.listJobs(user, query);
  }

  @Get('jobs/:id')
  @Roles(...RoleGroup.all)
  getJob(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.jobs.getJob(user, id);
  }

  @Patch('jobs/:id')
  @Roles(...RoleGroup.lead)
  updateJob(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkJobDto,
  ) {
    return this.jobs.updateJob(user, id, dto);
  }
}
