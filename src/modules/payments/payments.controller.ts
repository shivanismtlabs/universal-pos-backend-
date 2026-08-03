import {
  Body,
  Controller,
  Get,
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
  CreatePaymentDto,
  ListPaymentsQueryDto,
  RefundPaymentDto,
} from './dto/payments.dto';
import {
  CreateStripeIntentDto,
  VerifyStripePaymentDto,
} from './dto/stripe.dto';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

@ApiTags('payments')
@ApiBearerAuth('access-token')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly stripeService: StripeService,
  ) {}

  @Get('stripe/config')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Stripe public config (publishable key + enabled)' })
  stripeConfig() {
    return this.stripeService.getPublicConfig();
  }

  @Post('stripe/intent')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Create Stripe PaymentIntent (test/live)' })
  createStripeIntent(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStripeIntentDto,
  ) {
    return this.stripeService.createPaymentIntent(user, dto);
  }

  @Post('stripe/verify')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary: 'Verify Stripe PaymentIntent and record succeeded payment',
  })
  verifyStripe(
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyStripePaymentDto,
  ) {
    return this.stripeService.verifyAndRecord(user, dto);
  }

  @Post()
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Record a payment (idempotent)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto) {
    return this.paymentsService.create(user, dto);
  }

  @Get()
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'List payments, optionally filtered by order' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListPaymentsQueryDto) {
    return this.paymentsService.list(user, query);
  }

  @Get(':id')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Get payment by id' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentsService.getById(user, id);
  }

  @Post(':id/refund')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Refund a succeeded payment/deposit (idempotent)' })
  refund(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.paymentsService.refund(user, id, dto);
  }
}
