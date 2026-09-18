import { Injectable } from '@nestjs/common';
import type { SupplierAdapter } from '@storeforge/shared';
import { CjAdapter } from './cj.adapter';
import { SpocketAdapter } from './spocket.adapter';
import { ZendropAdapter } from './zendrop.adapter';

@Injectable()
export class SuppliersService {
  private adapters: Record<string, SupplierAdapter> = {
    cj: new CjAdapter(),
    spocket: new SpocketAdapter(),
    zendrop: new ZendropAdapter(),
  };

  get(id: string): SupplierAdapter {
    const adapter = this.adapters[id];
    if (!adapter) throw new Error(`Unknown supplier adapter: ${id}`);
    return adapter;
  }

  list() {
    return Object.values(this.adapters).map((a) => ({
      id: a.id,
      configured:
        a.id === 'cj' ? Boolean(process.env.CJ_API_KEY) : false,
      status: a.id === 'cj' ? (process.env.CJ_API_KEY ? 'live' : 'fixture/stub') : 'stub',
    }));
  }
}
