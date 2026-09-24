import { Controller, Get } from '@nestjs/common';
import type { DailySweepResult } from '@samtec/contracts';
import { Public } from '../../common/auth.decorators.js';
import { DetectionService } from './detection.service.js';

/**
 * `GET /api/v1/detection/daily-sweep`: the daily run, called by the Vercel
 * schedule in `apps/api/vercel.json` (docs/plan/08 §7).
 *
 * A controller of its own so that it carries **no** role: the rest of
 * `/detection` is ADMIN and HR_PAYROLL only, and a public route inside that
 * controller would read as a hole. Why it is safe to leave public is written
 * on `DetectionService.dailySweep`.
 */
@Controller('detection')
@Public()
export class DetectionScheduleController {
  constructor(private readonly detection: DetectionService) {}

  @Get('daily-sweep')
  dailySweep(): Promise<DailySweepResult> {
    return this.detection.dailySweep();
  }
}
