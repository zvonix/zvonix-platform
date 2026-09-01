import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MachineModule } from '../machine/machine.module.js';
import { NodeAgentController } from './node-agent.controller.js';
import { NodesController } from './nodes.controller.js';
import { NodesRepository } from './nodes.repository.js';
import { NodesService } from './nodes.service.js';

@Module({
  imports: [AuditModule, MachineModule],
  controllers: [NodesController, NodeAgentController],
  providers: [NodesService, NodesRepository],
  // Понадобится маршрутизации: вызов направляется только на узел, который отвечает.
  exports: [NodesService, NodesRepository],
})
export class NodesModule {}
