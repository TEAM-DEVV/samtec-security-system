import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Employee, EmployeeList } from '@samtec/contracts';
import { Caller, Roles, type SignedInUser } from '../../common/auth.decorators.js';
import { EmployeesService } from './employees.service.js';
import {
  idSchema,
  type ListEmployeesQuery,
  listEmployeesQuerySchema,
} from './workforce.schemas.js';

/**
 * `/api/v1/employees` (read side). Contract: operations `listEmployees` and
 * `getEmployee`. Creating, updating and terminating employees arrive later in
 * Phase 1, each with a contract change first.
 */
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listEmployeesQuerySchema }) query: ListEmployeesQuery,
  ): Promise<EmployeeList> {
    return this.employees.list(caller, query);
  }

  // No @Roles here: a GUARD may call it too, and the service decides that
  // they may only see themselves.
  @Get(':employeeId')
  get(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
  ): Promise<Employee> {
    return this.employees.get(caller, employeeId);
  }
}
