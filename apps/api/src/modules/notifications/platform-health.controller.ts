import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../http/auth.guard.js';
import { PlatformHealthService, type PlatformProblem } from './platform-health.service.js';

@Controller()
export class PlatformHealthController {
  constructor(private readonly health: PlatformHealthService) {}

  /** Поломки самой площадки (почта, воркер, сообщения MAX): красная точка в меню и строка в «Обзоре». */
  @Roles('admin', 'support')
  @Get('platform/problems')
  async problems(): Promise<{ count: number; problems: PlatformProblem[] }> {
    const problems = await this.health.problems();
    return { count: problems.length, problems };
  }
}
