import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ServersController } from './servers.controller.js';
import { ServersRepository } from './servers.repository.js';
import { ServersService } from './servers.service.js';

/** Нагрузка, память и диск площадки и узлов, история и срок её хранения (ADR-0065). */
@Module({
  imports: [NodesModule, SettingsModule],
  controllers: [ServersController],
  providers: [ServersService, ServersRepository],
  exports: [ServersService],
})
export class ServersModule {}
