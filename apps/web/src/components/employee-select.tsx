import { useState } from 'react';
import { SelectField } from '@/components/select-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { $api } from '@/lib/api';
import { describeApiError } from '@/lib/problem';

/** The contract's largest page. Beyond it, the search box finds the rest. */
const EMPLOYEE_PAGE_SIZE = 100;
/** The contract's minimum length for the `search` parameter. */
const SEARCH_MIN_LENGTH = 2;

interface EmployeeSelectProps {
  id: string;
  label: string;
  /** The chosen employee's ID, or '' for none. */
  value: string;
  onChange: (employeeId: string) => void;
  disabled?: boolean;
  /** True when the API complained about the employee link. */
  invalid?: boolean;
  /** The id of the text that explains this field, for screen readers. */
  describedBy?: string;
}

/**
 * Picks an employee to link a SUPERVISOR or GUARD account to: a search box
 * (staff number or name) and a drop-down of the matches. Without a search it
 * shows the first page; the employee already linked is always listed, even
 * when they have left the company, so the form never shows an empty box.
 */
export function EmployeeSelect({
  id,
  label,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: EmployeeSelectProps) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  const searching = term.length >= SEARCH_MIN_LENGTH;

  const employees = $api.useQuery('get', '/employees', {
    params: { query: { limit: EMPLOYEE_PAGE_SIZE, ...(searching && { search: term }) } },
  });
  const listed = employees.data?.items ?? [];
  // The linked employee may be outside the current page (or have left): fetch them by ID.
  const linkedIsListed = listed.some((employee) => employee.id === value);
  const linked = $api.useQuery(
    'get',
    '/employees/{employeeId}',
    { params: { path: { employeeId: value } } },
    { enabled: value !== '' && !linkedIsListed },
  );

  const options = listed
    .filter((employee) => employee.status !== 'TERMINATED')
    .map((employee) => ({
      id: employee.id,
      text: `${employee.staffNumber} · ${employee.fullName}`,
    }));
  if (value !== '' && !linkedIsListed && linked.data) {
    const left = linked.data.status === 'TERMINATED' ? ' (left the company)' : '';
    options.unshift({
      id: linked.data.id,
      text: `${linked.data.staffNumber} · ${linked.data.fullName}${left}`,
    });
  }

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-search`}>Find by staff number or name</Label>
        <Input
          id={`${id}-search`}
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Mensah, or SMT-00012"
          aria-describedby={`${id}-search-hint`}
        />
        <p id={`${id}-search-hint`} className="text-muted-foreground text-xs">
          {searching
            ? `Employees matching "${term}".`
            : `The first ${EMPLOYEE_PAGE_SIZE} employees. Type at least ${SEARCH_MIN_LENGTH} characters to find others.`}
        </p>
      </div>
      <SelectField
        id={id}
        label={label}
        value={value}
        onChange={onChange}
        disabled={disabled || employees.isPending || employees.isError}
        invalid={invalid}
        describedBy={describedBy}
      >
        <option value="">
          {employees.isPending ? 'Loading employees…' : 'Choose an employee'}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.text}
          </option>
        ))}
      </SelectField>
      {employees.isError && (
        <p className="text-destructive text-xs">
          The employee list could not be loaded: {describeApiError(employees.error).message}
        </p>
      )}
    </div>
  );
}
