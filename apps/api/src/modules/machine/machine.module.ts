import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MachineController } from './machine.controller.js';
import { MachineRepository } from './machine.repository.js';
import { MachineSelfController } from './machine-self.controller.js';
import { MachineService } from './machine.service.js';

@Module({
  imports: [AuditModule],
  controllers: [MachineController, MachineSelfController],
  providers: [MachineService, MachineRepository],
  // Экспортируется для глобального защитника: он проверяет машинный ключ там,
  // где обработчик помечен `@Machine()`.
  exports: [MachineService],
})
export class MachineModule {}
