import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  IamAttendanceService,
  IamShiftsService,
} from './iam-attendance-shifts.service';
import { IamController } from './iam.controller';
import { IamRolesService } from './iam-roles.service';
import { IamWebAuthnService } from './iam-webauthn.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [IamController],
  providers: [
    IamRolesService,
    IamAttendanceService,
    IamShiftsService,
    IamWebAuthnService,
  ],
  exports: [IamRolesService],
})
export class IamModule {}
