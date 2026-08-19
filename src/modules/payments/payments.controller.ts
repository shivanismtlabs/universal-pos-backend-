import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { RoleGroup } from '../../common/roles';
import { SkipThrottle } from '@nestjs/throttler';
import { Public, Roles } from '../auth/decorators/auth.decorators';
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
import { isStripeTender } from './payment-capabilities';

@ApiTags('payments')
@ApiBearerAuth('access-token')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly stripeService: StripeService,
  ) {}

  @Get('methods')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Enabled/configured payment methods for POS' })
  methods() {
    return this.paymentsService.listMethods();
  }

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

  @Public()
  @SkipThrottle()
  @Post('stripe/webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stripe webhook (signature-verified, idempotent)' })
  stripeWebhook(
    @Req() req: FastifyRequest & { rawBody?: Buffer | string },
    @Headers('stripe-signature') signature?: string,
  ) {
    const raw = req.rawBody;
    if (raw == null) {
      throw new BadRequestException(
        'Missing raw body for Stripe signature verification',
      );
    }
    return this.stripeService.handleWebhook(raw, signature);
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

  @Post(':id/confirm')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Confirm a pending bank transfer' })
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentsService.confirmBankTransfer(user, id);
  }

  @Post(':id/refund')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Refund a succeeded payment/deposit (idempotent)' })
  async refund(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundPaymentDto,
  ) {
    const parent = await this.paymentsService.getById(user, id);
    if (
      isStripeTender(parent.method) ||
      parent.provider === 'stripe' ||
      parent.gatewayRef?.startsWith('pi_')
    ) {
      return this.stripeService.refundOrderPayment(user, id, dto);
    }
    return this.paymentsService.refund(user, id, dto);
  }
}
