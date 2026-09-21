import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pageRoles } from '@/lib/roles';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { RequireRole } from './require-role';

function renderEmployeesOnlyPage() {
  return renderWithProviders(
    <RequireRole roles={pageRoles.employees}>
      <p>Employee list</p>
    </RequireRole>,
  );
}

describe('RequireRole', () => {
  it('shows the page to a role that is allowed', async () => {
    await signInForTests('supervisor@samtec.example');

    renderEmployeesOnlyPage();

    expect(screen.getByText('Employee list')).toBeInTheDocument();
  });

  it('shows a "not for your role" page to a guard, with the API wording', async () => {
    await signInForTests('guard@samtec.example');

    renderEmployeesOnlyPage();

    expect(screen.getByText('Not available for your role')).toBeInTheDocument();
    expect(screen.getByText(/Your role does not allow this action/)).toBeInTheDocument();
    expect(screen.queryByText('Employee list')).not.toBeInTheDocument();
  });
});
