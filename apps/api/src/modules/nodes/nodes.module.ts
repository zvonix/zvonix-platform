import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MachineModule } from '../machine/machine.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { NodeInstallController } from './install.controller.js';
import { NodeAgentController } from './node-agent.controller.js';
import { NodeCommandsController } from './node-commands.controller.js';
import { NodeCommandsService } from './node-commands.service.js';
import { NodeSetService } from './node-set.service.js';
import { NodesController } from './nodes.controller.js';
import { NodesRepository } from './nodes.repository.js';
import { NameResolver } from './name-resolver.js';
import { NodesService } from './nodes.service.js';

@Module({
  imports: [AuditModule, MachineModule, SettingsModule],
  controllers: [
    NodesController,
    NodeAgentController,
    NodeInstallController,
    NodeCommandsController,
  ],
  providers: [NodesService, NodesRepository, NodeSetService, NameResolver, NodeCommandsService],
  // Понадобится маршрутизации: вызов направляется только на узел, который отвечает.
  exports: [NodesService, NodesRepository, NodeSetService, NodeCommandsService],
})
export class NodesModule {}
