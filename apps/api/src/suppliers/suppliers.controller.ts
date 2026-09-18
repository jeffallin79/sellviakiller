import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  list() {
    return this.suppliers.list();
  }
}
