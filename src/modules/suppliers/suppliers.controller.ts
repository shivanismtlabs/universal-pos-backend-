import {
  Body,
  Controller,
  Get,
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
import {
  AddSupplierNoteDto,
  CreatePurchaseOrderDto,
  CreateSupplierDto,
  CreateSupplierInvoiceDto,
  CreateSupplierPaymentDto,
  PaySupplierInvoiceDto,
  ReceivePurchaseOrderDto,
  ReturnPurchaseOrderDto,
  SupplierAddressDto,
  SupplierContactDto,
  UpdatePurchaseOrderDto,
  UpdateSupplierDto,
  UploadSupplierDocumentDto,
} from './dto/suppliers.dto';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.catalogWrite)
@Controller()
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Post('suppliers')
  @ApiOperation({ summary: 'Create supplier' })
  createSupplier(@CurrentUser() user: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.suppliersService.createSupplier(user, dto);
  }

  @Get('suppliers')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List suppliers' })
  listSuppliers(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
  ) {
    return this.suppliersService.listSuppliers(user, status);
  }

  @Get('suppliers/:id')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Get supplier' })
  getSupplier(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.getSupplier(user, id);
  }

  @Get('suppliers/:id/ledger')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Supplier AP ledger (invoices + payments)' })
  supplierLedger(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.supplierLedger(user, id);
  }

  @Patch('suppliers/:id')
  @ApiOperation({ summary: 'Update supplier' })
  updateSupplier(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliersService.updateSupplier(user, id, dto);
  }

  @Post('suppliers/:id/contacts')
  @ApiOperation({ summary: 'Add a supplier contact' })
  addContact(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupplierContactDto,
  ) {
    return this.suppliersService.addContact(user, id, dto);
  }

  @Post('suppliers/:id/addresses')
  @ApiOperation({ summary: 'Add a supplier address' })
  addAddress(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupplierAddressDto,
  ) {
    return this.suppliersService.addAddress(user, id, dto);
  }

  @Post('suppliers/:id/notes')
  @ApiOperation({ summary: 'Add supplier activity note' })
  addNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddSupplierNoteDto,
  ) {
    return this.suppliersService.addNote(user, id, dto);
  }

  @Post('suppliers/:id/documents')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Upload supplier document (image/file as data URL)' })
  addDocument(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadSupplierDocumentDto,
  ) {
    return this.suppliersService.addDocument(user, id, dto);
  }

  @Post('purchase-orders')
  @ApiOperation({ summary: 'Create purchase order (optional stock lines)' })
  createPo(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.suppliersService.createPo(user, dto);
  }

  @Get('purchase-orders')
  @ApiOperation({ summary: 'List purchase orders' })
  listPos(@CurrentUser() user: AuthUser) {
    return this.suppliersService.listPos(user);
  }

  @Get('purchase-orders/:id')
  @ApiOperation({ summary: 'Get purchase order with lines' })
  getPo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.getPo(user, id);
  }

  @Patch('purchase-orders/:id')
  @ApiOperation({ summary: 'Update PO status / delivery (not receive)' })
  updatePo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return this.suppliersService.updatePo(user, id, dto);
  }

  @Post('purchase-orders/:id/receive')
  @ApiOperation({
    summary: 'Receive goods — creates GRN + increments StockLevel',
  })
  receivePo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseOrderDto,
  ) {
    return this.suppliersService.receivePo(user, id, dto);
  }

  @Post('purchase-orders/:id/return')
  @ApiOperation({
    summary: 'Purchase return (RTV) — decrement received qty + shelf stock',
  })
  returnPo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnPurchaseOrderDto,
  ) {
    return this.suppliersService.returnPo(user, id, dto);
  }

  @Get('goods-receipts')
  @ApiOperation({ summary: 'List goods received notes (GRN)' })
  listGrns(@CurrentUser() user: AuthUser) {
    return this.suppliersService.listGoodsReceipts(user);
  }

  @Get('goods-receipts/:id')
  @ApiOperation({ summary: 'Get GRN' })
  getGrn(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.getGoodsReceipt(user, id);
  }

  @Post('goods-receipts/:id/invoice')
  @ApiOperation({ summary: 'Create supplier invoice from GRN line costs' })
  invoiceFromGrn(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.createInvoiceFromGrn(user, id);
  }

  @Post('supplier-invoices')
  @ApiOperation({ summary: 'Create supplier invoice / credit note' })
  createInvoice(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSupplierInvoiceDto,
  ) {
    return this.suppliersService.createInvoice(user, dto);
  }

  @Get('supplier-invoices')
  @ApiOperation({ summary: 'List supplier invoices' })
  listInvoices(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
  ) {
    return this.suppliersService.listInvoices(user, status);
  }

  @Get('supplier-invoices/outstanding')
  @ApiOperation({ summary: 'Open / partial supplier balances' })
  listOutstanding(@CurrentUser() user: AuthUser) {
    return this.suppliersService.listOutstanding(user);
  }

  @Post('supplier-invoices/:id/pay')
  @ApiOperation({ summary: 'Record payment against supplier invoice' })
  payInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySupplierInvoiceDto,
  ) {
    return this.suppliersService.payInvoice(user, id, dto);
  }

  @Post('supplier-payments')
  @ApiOperation({ summary: 'Record supplier payment (optionally against invoice)' })
  createPayment(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSupplierPaymentDto,
  ) {
    return this.suppliersService.createPayment(user, dto);
  }

  @Get('supplier-payments')
  @ApiOperation({ summary: 'List supplier payments' })
  listPayments(
    @CurrentUser() user: AuthUser,
    @Query('supplierId') supplierId?: string,
  ) {
    return this.suppliersService.listPayments(user, supplierId);
  }
}
