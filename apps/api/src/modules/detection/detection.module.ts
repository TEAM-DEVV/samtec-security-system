import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { DetectionController } from './detection.controller.js';
import { DetectionService } from './detection.service.js';
import { DetectionScheduleController } from './detection-schedule.controller.js';

/**
 * Ghost detection (docs/plan/08-ghost-detection-engine.md). It owns
 * `detection_rules`, `detection_alerts` and `detection_checks`, and reads
 * everything else through the module that owns it.
 *
 * Imports point one way only: detection → payroll, attendance, workforce and
 * identity. **Nothing imports detection.** That is why rule R3, which blocks a
 * payroll submission, is enforced inside payroll through the shared function
 * in `src/common/paid-beyond-presence.ts` rather than by a call back in here.
 */
@Module({
  imports: [IdentityModule, WorkforceModule, AttendanceModule, PayrollModule],
  controllers: [DetectionController, DetectionScheduleController],
  providers: [DetectionService],
})
export class DetectionModule {}
