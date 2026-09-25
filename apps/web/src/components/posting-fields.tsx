import { SelectField } from '@/components/select-field';
import { SiteSelect } from '@/components/site-select';
import { $api } from '@/lib/api';

/** The contract's largest page. A company has far fewer posts and patterns than this. */
const PAGE_SIZE = 100;

/** Where an employee is posted: a site, and optionally a post and a shift at it. */
export interface Posting {
  siteId: string;
  postId: string;
  shiftPatternId: string;
}

/** Nobody is posted anywhere. */
export const NO_POSTING: Posting = { siteId: '', postId: '', shiftPatternId: '' };

interface PostingFieldsProps {
  value: Posting;
  onChange: (posting: Posting) => void;
  disabled?: boolean;
  /** The field the API complained about, so the right box is marked. */
  badField?: string;
  /** The id of the text explaining the problem, for screen readers. */
  describedBy?: string;
}

/**
 * The three posting fields, used by both employee forms.
 *
 * A post belongs to a site and a shift is worked at a site, so choosing a
 * different site clears both — sending a post from the old site would be
 * refused by the API anyway, and silently keeping it on screen would look like
 * it had been saved.
 */
export function PostingFields({
  value,
  onChange,
  disabled,
  badField,
  describedBy,
}: PostingFieldsProps) {
  const posts = $api.useQuery(
    'get',
    '/sites/{siteId}/posts',
    { params: { path: { siteId: value.siteId }, query: { limit: PAGE_SIZE } } },
    // No site chosen means there is nothing to ask for.
    { enabled: value.siteId !== '' },
  );
  const patterns = $api.useQuery('get', '/shift-patterns', {
    params: { query: { limit: PAGE_SIZE } },
  });

  // A closed post is kept for history and must not be handed out again — but if
  // somebody is already on one, it stays in the list. Dropping it would show
  // "No particular post" while the form still held the old one.
  const choosablePosts = (posts.data?.items ?? []).filter(
    (post) => post.status === 'ACTIVE' || post.id === value.postId,
  );

  return (
    <>
      <SiteSelect
        id="employee-site"
        label="Posted to"
        emptyLabel="Not posted anywhere"
        value={value.siteId}
        disabled={disabled}
        onChange={(siteId) => onChange({ ...NO_POSTING, siteId })}
      />

      {value.siteId !== '' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="employee-post"
            label="Post at the site"
            value={value.postId}
            disabled={disabled || posts.isPending || posts.isError}
            invalid={badField === 'postId'}
            describedBy={badField === 'postId' ? describedBy : undefined}
            onChange={(postId) => onChange({ ...value, postId })}
          >
            <option value="">{posts.isPending ? 'Loading posts…' : 'No particular post'}</option>
            {choosablePosts.map((post) => (
              <option key={post.id} value={post.id}>
                {post.name}
                {post.status === 'ACTIVE' ? '' : ' (closed)'}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="employee-shift"
            label="Shift worked"
            value={value.shiftPatternId}
            disabled={disabled || patterns.isPending || patterns.isError}
            invalid={badField === 'shiftPatternId'}
            describedBy={badField === 'shiftPatternId' ? describedBy : undefined}
            onChange={(shiftPatternId) => onChange({ ...value, shiftPatternId })}
          >
            <option value="">{patterns.isPending ? 'Loading shifts…' : 'No fixed shift'}</option>
            {(patterns.data?.items ?? []).map((pattern) => (
              <option key={pattern.id} value={pattern.id}>
                {pattern.name} · {pattern.startTime}–{pattern.endTime}
              </option>
            ))}
          </SelectField>
        </div>
      )}
    </>
  );
}
