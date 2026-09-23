import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkforceModule } from '../workforce/workforce.module.js';
import { DetectionController } from './detection.controller.js';
import { DetectionService } from './detection.service.js';

/**
 * Ghost detection (docs/plan/08-ghost-detection-engine.md). It owns
 * `detection_rules`, `detection_alerts` and `detection_checks`, and reads
 * everything else through the module that owns it.
 *
 * Imports point one way only: detection → attendance → workforce → identity.
 * **Nothing imports detection.** That is why rule R3, which blocks a payroll
 * submission, is enforced inside payroll from its own data rather than by a
 * call back into here.
 */
@Module({
  imports: [IdentityModule, WorkforceModule, AttendanceModule],
  controllers: [DetectionController],
  providers: [DetectionService],
})
export class DetectionModule {}
