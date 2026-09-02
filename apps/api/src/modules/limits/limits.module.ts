import { Module } from '@nestjs/common';
import { LimitsService } from './limits.service.js';

/**
 * Счётчики по окнам (ARCHITECTURE.md).
 *
 * Пока единственный потребитель — ограничение частоты входа и регистрации по адресу
 * источника. К этапу 4 сюда придут лимиты клиента, канала, партнёра и SIM: считаются
 * они тем же счётчиком, отличаются только правилом и ключом.
 */
@Module({
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
