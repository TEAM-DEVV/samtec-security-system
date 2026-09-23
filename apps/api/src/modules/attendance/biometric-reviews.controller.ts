import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  BiometricCollision,
  BiometricCollisionList,
  EmployeeBiometrics,
} from '@samtec/contracts';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import {
  type BiometricReasonBody,
  biometricReasonSchema,
  idSchema,
  type ListCollisionsQuery,
  listCollisionsQuerySchema,
  type RequestExemptionBody,
  type ResolveCollisionBody,
  type ReviewExemptionBody,
  requestExemptionSchema,
  resolveCollisionSchema,
  reviewExemptionSchema,
} from './attendance.schemas.js';
import { BiometricReviewsService } from './biometric-reviews.service.js';

/**
 * The dashboard's biometric screens. Contract: the `Biometrics` operations;
 * the rules are in docs/plan/13-biometrics-design.md section 2.
 *
 * Anything that would let one person put a worker to work on their own needs
 * a second ADMIN, and nobody ever decides on their own action.
 */
@Controller()
export class BiometricReviewsController {
  constructor(private readonly reviews: BiometricReviewsService) {}

  @Get('employees/:employeeId/biometrics')
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  biometrics(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
  ): Promise<EmployeeBiometrics> {
    return this.reviews.employeeBiometrics(caller, employeeId);
  }

  @Post('employees/:employeeId/biometrics/revoke')
  @Roles('ADMIN')
  @HttpCode(200)
  revoke(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: biometricReasonSchema }) body: BiometricReasonBody,
  ): Promise<EmployeeBiometrics> {
    return this.reviews.revoke(caller, employeeId, body);
  }

  @Post('employees/:employeeId/biometric-consents/withdraw')
  @Roles('ADMIN')
  @HttpCode(200)
  withdraw(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: biometricReasonSchema }) body: BiometricReasonBody,
  ): Promise<EmployeeBiometrics> {
    return this.reviews.withdrawConsent(caller, employeeId, body);
  }

  @Post('employees/:employeeId/biometric-exemption')
  @Roles('ADMIN')
  @HttpCode(200)
  requestExemption(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: requestExemptionSchema }) body: RequestExemptionBody,
  ): Promise<EmployeeBiometrics> {
    return this.reviews.requestExemption(caller, employeeId, body);
  }

  @Post('employees/:employeeId/biometric-exemption/review')
  @Roles('ADMIN')
  @HttpCode(200)
  reviewExemption(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: reviewExemptionSchema }) body: ReviewExemptionBody,
  ): Promise<EmployeeBiometrics> {
    return this.reviews.reviewExemption(caller, employeeId, body);
  }

  @Get('biometric-collisions')
  @Roles('ADMIN')
  listCollisions(
    @Caller() caller: SignedInUser,
    @Query({ schema: listCollisionsQuerySchema }) query: ListCollisionsQuery,
  ): Promise<BiometricCollisionList> {
    return this.reviews.listCollisions(caller, query);
  }

  @Post('biometric-collisions/:credentialId/resolve')
  @Roles('ADMIN')
  @HttpCode(200)
  resolveCollision(
    @Caller() caller: SignedInUser,
    @Param('credentialId', { schema: idSchema }) credentialId: string,
    @Body({ schema: resolveCollisionSchema }) body: ResolveCollisionBody,
  ): Promise<BiometricCollision> {
    return this.reviews.resolveCollision(caller, credentialId, body);
  }
}
