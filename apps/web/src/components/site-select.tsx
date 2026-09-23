import { SelectField } from '@/components/select-field';
import { $api } from '@/lib/api';
import { useSession } from '@/lib/session';

/** The contract's largest page; a company has far fewer sites than that. */
const SITE_PAGE_SIZE = 100;

interface SiteSelectProps {
  id: string;
  label: string;
  /** The chosen site's ID, or '' for all sites. */
  value: string;
  onChange: (siteId: string) => void;
  /** What the empty choice says, for example "All sites" or "Choose a site". */
  emptyLabel: string;
  disabled?: boolean;
}

/**
 * A drop-down of the sites the signed-in person may see (the API scopes a
 * supervisor to their own site), by code and name.
 */
export function SiteSelect({ id, label, value, onChange, emptyLabel, disabled }: SiteSelectProps) {
  const sites = $api.useQuery('get', '/sites', { params: { query: { limit: SITE_PAGE_SIZE } } });
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled || sites.isPending || sites.isError}
    >
      <option value="">{sites.isPending ? 'Loading sites…' : emptyLabel}</option>
      {(sites.data?.items ?? []).map((site) => (
        <option key={site.id} value={site.id}>
          {site.code} · {site.name}
        </option>
      ))}
    </SelectField>
  );
}

/**
 * Site names by ID, for tables that only carry a `siteId`. Empty until the
 * sites have loaded. A guard may not list sites, so for them the name comes
 * from their own employee record (the site they are posted to).
 */
export function useSiteNames(): Map<string, string> {
  const session = useSession();
  const isGuard = session?.user.role === 'GUARD';
  const employeeId = session?.user.employeeId ?? '';
  const sites = $api.useQuery(
    'get',
    '/sites',
    { params: { query: { limit: SITE_PAGE_SIZE } } },
    { enabled: session !== null && !isGuard },
  );
  const self = $api.useQuery(
    'get',
    '/employees/{employeeId}',
    { params: { path: { employeeId } } },
    { enabled: isGuard && employeeId !== '' },
  );
  const names = new Map(
    (sites.data?.items ?? []).map((site) => [site.id, `${site.code} · ${site.name}`]),
  );
  const posted = self.data?.currentSite;
  if (posted) {
    names.set(posted.id, `${posted.code} · ${posted.name}`);
  }
  return names;
}
