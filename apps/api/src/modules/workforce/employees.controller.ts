import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Employee, EmployeeList } from '@samtec/contracts';
import type { Response } from 'express';
import {
  Caller,
  NeedsPassword,
  OnKiosk,
  Roles,
  type SignedInUser,
} from '../../common/auth.decorators.js';
import { EmployeesService } from './employees.service.js';
import {
  type ChangeStartDateBody,
  type CreateEmployeeBody,
  changeStartDateSchema,
  createEmployeeSchema,
  idSchema,
  type ListEmployeesQuery,
  listEmployeesQuerySchema,
  type TerminateEmployeeBody,
  terminateEmployeeSchema,
  type UpdateEmployeeBody,
  updateEmployeeSchema,
} from './workforce.schemas.js';

/**
 * `/api/v1/employees`. Contract: operations `listEmployees`, `getEmployee`,
 * `createEmployee`, `updateEmployee`, `changeEmployeeStartDate` and `terminateEmployee`.
 */
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  // The kiosk picks the worker to enroll from this list. It carries no Ghana
  // Card numbers, so a shared screen never shows one.
  @OnKiosk()
  @Get()
  @Roles('ADMIN', 'HR_PAYROLL', 'SUPERVISOR')
  list(
    @Caller() caller: SignedInUser,
    @Query({ schema: listEmployeesQuerySchema }) query: ListEmployeesQuery,
  ): Promise<EmployeeList> {
    return this.employees.list(caller, query);
  }

  @Post()
  @Roles('ADMIN', 'HR_PAYROLL')
  async create(
    @Caller() caller: SignedInUser,
    @Body({ schema: createEmployeeSchema }) body: CreateEmployeeBody,
    // passthrough keeps Nest in charge of the response; we only add a header.
    @Res({ passthrough: true }) response: Response,
  ): Promise<Employee> {
    const employee = await this.employees.create(caller, body);
    response.status(201).setHeader('Location', `/api/v1/employees/${employee.id}`);
    return employee;
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

  @Patch(':employeeId')
  @Roles('ADMIN', 'HR_PAYROLL')
  update(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: updateEmployeeSchema }) body: UpdateEmployeeBody,
  ): Promise<Employee> {
    return this.employees.update(caller, employeeId, body);
  }

  // Its own route, so only this correction asks for the password: editing a
  // phone number or a posting stays one click.
  @NeedsPassword()
  @Put(':employeeId/start-date')
  @Roles('ADMIN', 'HR_PAYROLL')
  changeStartDate(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: changeStartDateSchema }) body: ChangeStartDateBody,
  ): Promise<Employee> {
    return this.employees.changeStartDate(caller, employeeId, body);
  }

  @NeedsPassword()
  @Post(':employeeId/terminate')
  @HttpCode(200) // A POST answers 201 by default, but nothing new is created here.
  @Roles('ADMIN', 'HR_PAYROLL')
  terminate(
    @Caller() caller: SignedInUser,
    @Param('employeeId', { schema: idSchema }) employeeId: string,
    @Body({ schema: terminateEmployeeSchema }) body: TerminateEmployeeBody,
  ): Promise<Employee> {
    return this.employees.terminate(caller, employeeId, body);
  }
}
