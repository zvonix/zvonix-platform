/**
 * Обращения партнёра о своих вызовах ([ADR-0013](../../../../../docs/adr/0013-opredelenie-operatora.md)).
 *
 * Главное из них — «вызов ушёл не в мою сеть». Партнёр видит счёт от своего оператора
 * и знает про неверное определение раньше нас: у него это деньги, у нас — строка в базе.
 * Поэтому его обращение отменяет запись **немедленно**, независимо от срока годности.
 */

import { Injectable } from '@nestjs/common';
import {
  isStaffRole,
  notFound,
  parseMsisdn,
  rateLimited,
  type CallStatus,
  type Id,
  type Msisdn,
  type UserRole,
} from '@zvonix/shared';
import { AuditService } from '../audit/audit.service.js';
import { BillingRepository } from '../billing/billing.repository.js';
import { OperatorResolverService } from '../catalog/operator-resolver.service.js';
import { RateLimitService, type LimitRule } from '../limits/rate-limit.service.js';
import { CallRepository, type CallId, type CallRow } from './call.repository.js';

/**
 * Сколько обращений в час принимается от одного партнёра.
 *
 * Не про добросовестность, а про пропускную способность: каждая отмена отправляет номер
 * на повторное определение, а внешний источник держит **два запроса в секунду на всю
 * платформу** (ADR-0013). Партнёр, отменяющий всё подряд, оставил бы без определения
 * чужие вызовы — и не по злому умыслу, а по ошибке в своей выгрузке.
 */
const WRONG_NETWORK_RULE: LimitRule = {
  name: 'wrong-network',
  limit: 50,
  windowSeconds: 3600,
};

@Injectable()
export class PartnerReportService {
  constructor(
    private readonly calls: CallRepository,
    private readonly billing: BillingRepository,
    private readonly resolver: OperatorResolverService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Вызовы партнёра страницами: по ним он сверяется со счётом своего оператора.
   *
   * Отбор общий с административным списком (`CallRepository.list`), но наружу уходит
   * только сам вызов: канал, клиент и номер SIM из окружения сюда не попадают.
   * Отбор по шлюзу, а не по SIM: SIM переживает порт и может переехать к другому
   * владельцу, а вызов ушёл через то железо, которое стояло тогда. Вызовы через
   * SIP-транк партнёра входят тоже — транк и есть его шлюз.
   */
  async listCalls(
    requester: { userId: Id<'user'>; role: UserRole },
    filter: {
      readonly partnerId?: Id<'partner'>;
      readonly status?: CallStatus;
      readonly from?: Date;
      readonly to?: Date;
      readonly limit: number;
      readonly offset: number;
    },
  ): Promise<{ rows: CallRow[]; total: number }> {
    const found = await this.calls.list({
      partnerId: await this.subjectOf(requester, filter.partnerId),
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.from === undefined ? {} : { from: filter.from }),
      ...(filter.to === undefined ? {} : { to: filter.to }),
      limit: filter.limit,
      offset: filter.offset,
    });
    return { rows: found.rows.map((row) => row.call), total: found.total };
  }

  /**
   * «Этот вызов ушёл не в мою сеть».
   *
   * Обращение привязано к **вызову**, а не к номеру: по номеру партнёр мог бы отменить
   * определение чего угодно, включая номера, которых он не обслуживал. Вызов же
   * ограничивает обращение тем, что действительно ушло через его железо.
   */
  async reportWrongNetwork(
    callId: CallId,
    requester: { userId: Id<'user'>; role: UserRole },
  ): Promise<{ invalidated: boolean; destination: Msisdn }> {
    const found = await this.calls.findWithPartner(callId);
    // Чужой вызов и несуществующий отвечают одинаково: иначе по разнице ответов
    // проверяется, обслуживал ли этот вызов кто-то другой.
    if (found === undefined) throw notFound('Вызов не найден');

    // Администратор сообщает о любом вызове; остальных защитник пустил по кабинету
    // партнёра, и сообщают они только о вызовах через свои SIM.
    if (requester.role !== 'admin') {
      const partner = await this.billing.findPartnerOwnedBy(requester.userId);
      if (partner === undefined || partner.id !== found.partnerId) {
        throw notFound('Вызов не найден');
      }

      const verdict = await this.rateLimit.hit(WRONG_NETWORK_RULE, found.partnerId);
      if (!verdict.allowed) {
        throw rateLimited('Слишком много обращений за час', {
          details: { retry_after_seconds: verdict.retryAfterSeconds },
        });
      }
    }

    // Назначение здесь заведомо каноническое: у вызова, дошедшего до партнёра, есть шлюз,
    // а у отказа `destination_invalid` шлюза нет — до отбора кандидатов он не доходит
    // (ADR-0042). Разбор оставлен явным, чтобы связь не держалась на одном рассуждении:
    // если она когда-нибудь порвётся, это будет отказ, а не молча неверный номер.
    const destination = parseMsisdn(found.call.destination);
    const invalidated = await this.resolver.invalidate(destination);

    await this.audit.record({
      action: 'call.wrong_network_reported',
      entityType: 'call',
      entityId: callId,
      actorUserId: requester.userId,
      actorRole: requester.role,
      // Номер в журнале не маскируется намеренно: это запись о конкретном номере,
      // определённом неверно, и без него разбирать нечего. Читают журнал только
      // администратор и поддержка.
      after: { destination, partner_id: found.partnerId, invalidated },
    });

    return { invalidated, destination };
  }

  /**
   * Чей это партнёр.
   *
   * Партнёр видит только свои вызовы, администратор и поддержка — вызовы названного
   * партнёра. Кабинет здесь первый рубеж, а не единственный: защитник проверил, что
   * у человека есть карточка партнёра, но не то, о каком партнёре он спрашивает.
   */
  private async subjectOf(
    requester: { userId: Id<'user'>; role: UserRole },
    partnerId: Id<'partner'> | undefined,
  ): Promise<Id<'partner'>> {
    if (!isStaffRole(requester.role)) {
      const partner = await this.billing.findPartnerOwnedBy(requester.userId);
      if (partner === undefined) throw notFound('Партнёр не найден');
      return partner.id;
    }
    if (partnerId === undefined) throw notFound('Партнёр не назван');
    return partnerId;
  }
}
