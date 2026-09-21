import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  AttendanceException,
  AttendanceExceptionList,
  WorkSegmentList,
} from '@samtec/contracts';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import {
  idSchema,
  type ListExceptionsQuery,
  type ListSegmentsQuery,
  listExceptionsQuerySchema,
  listSegmentsQuerySchema,
  type ResolveExceptionBody,
  resolveExceptionSchema,
} from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** `/api/v1/attendance`. Contract: the `Attendance` operations. */
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** Every signed-in role; the service scopes what each one sees. */
  @Get('segments')
  listSegments(
    @Caller() caller: SignedInUser,
    @Query({ schema: listSegmentsQuerySchema }) query: ListSegmentsQuery,
  ): Promise<WorkSegmentList> {
    return this.attendance.listSegments(caller, query);
  }

  @Get('exceptions')
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  listExceptions(
    @Caller() caller: SignedInUser,
    @Query({ schema: listExceptionsQuerySchema }) query: ListExceptionsQuery,
  ): Promise<AttendanceExceptionList> {
    return this.attendance.listExceptions(caller, query);
  }

  @Get('exceptions/:exceptionId')
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  getException(
    @Caller() caller: SignedInUser,
    @Param('exceptionId', { schema: idSchema }) exceptionId: string,
  ): Promise<AttendanceException> {
    return this.attendance.getException(caller, exceptionId);
  }

  /** HR_PAYROLL reads the queue but never resolves it: those who run payroll never create hours. */
  @Post('exceptions/:exceptionId/resolve')
  @Roles('ADMIN', 'SUPERVISOR')
  @HttpCode(200)
  resolve(
    @Caller() caller: SignedInUser,
    @Param('exceptionId', { schema: idSchema }) exceptionId: string,
    @Body({ schema: resolveExceptionSchema }) body: ResolveExceptionBody,
  ): Promise<AttendanceException> {
    return this.attendance.resolve(caller, exceptionId, body);
  }
}
