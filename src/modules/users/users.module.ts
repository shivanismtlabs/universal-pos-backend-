import { Module } from '@nestjs/common';
import { AuthSessionModule } from '../auth/auth-session.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** Staff/user management + role assignment — FR-USR */
@Module({
  imports: [AuthSessionModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
