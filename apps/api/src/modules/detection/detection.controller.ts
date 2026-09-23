import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  DetectionAlert,
  DetectionAlertList,
  DetectionRule,
  DetectionRuleList,
  DetectionSweepResult,
  RiskScoreList,
} from '@samtec/contracts';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import type { DetectionRuleCode } from '../../generated/prisma/enums.js';
import {
  idSchema,
  type ListAlertsQuery,
  listAlertsQuerySchema,
  type ResolveAlertBody,
  type RiskScoresQuery,
  resolveAlertSchema,
  riskScoresQuerySchema,
  ruleCodeSchema,
  type UpdateDetectionRuleBody,
  updateDetectionRuleSchema,
} from './detection.schemas.js';
import { DetectionService } from './detection.service.js';

/**
 * `/api/v1/detection/*`. Contract: the `Detection` operations.
 *
 * **ADMIN and HR_PAYROLL only.** A supervisor never sees this queue: a
 * supervisor is themselves a subject of rule R7, so it would show them their
 * own file (docs/plan/08 section 6).
 */
@Controller('detection')
@Roles('ADMIN', 'HR_PAYROLL')
export class DetectionController {
  constructor(private readonly detection: DetectionService) {}

  @Get('alerts')
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listAlertsQuerySchema }) query: ListAlertsQuery,
  ): Promise<DetectionAlertList> {
    return this.detection.list(caller, query);
  }

  @Get('alerts/:alertId')
  get(
    @Caller() caller: SignedInUser,
    @Param('alertId', { schema: idSchema }) alertId: string,
  ): Promise<DetectionAlert> {
    return this.detection.get(caller, alertId);
  }

  @Post('alerts/:alertId/resolve')
  @HttpCode(200)
  resolve(
    @Caller() caller: SignedInUser,
    @Param('alertId', { schema: idSchema }) alertId: string,
    @Body({ schema: resolveAlertSchema }) body: ResolveAlertBody,
  ): Promise<DetectionAlert> {
    return this.detection.resolve(caller, alertId, body);
  }

  /** Running it again raises nothing new, so it is safe to press twice. */
  @Roles('ADMIN')
  @Post('sweep')
  @HttpCode(200)
  sweep(@Caller() caller: SignedInUser): Promise<DetectionSweepResult> {
    return this.detection.sweep(caller);
  }

  @Get('rules')
  rules(@Caller() caller: SignedInUser): Promise<DetectionRuleList> {
    return this.detection.rules(caller);
  }

  @Roles('ADMIN')
  @Patch('rules/:ruleCode')
  updateRule(
    @Caller() caller: SignedInUser,
    @Param('ruleCode', { schema: ruleCodeSchema }) ruleCode: DetectionRuleCode,
    @Body({ schema: updateDetectionRuleSchema }) body: UpdateDetectionRuleBody,
  ): Promise<DetectionRule> {
    return this.detection.updateRule(caller, ruleCode, body);
  }

  @Get('risk-scores')
  riskScores(
    @Caller() caller: SignedInUser,
    @Query({ schema: riskScoresQuerySchema }) query: RiskScoresQuery,
  ): Promise<RiskScoreList> {
    return this.detection.riskScores(caller, query.limit);
  }
}
