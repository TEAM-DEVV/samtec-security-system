/**
 * Downloading a file the API only gives to somebody signed in.
 *
 * A plain `<a href>` cannot be used for these: the browser would send the
 * request without the access token, and the API would answer 401. So the file is
 * fetched through the same client every page uses — which adds the token and
 * refreshes it when it has expired — and then handed to the browser as a blob.
 *
 * The two files this exists for are the bank file and a payslip. Both carry
 * personal data, both are answered with `Cache-Control: no-store`, and both are
 * recorded against the name of whoever asked. The object URL is released as soon
 * as the click is over, so the bytes do not sit in memory afterwards.
 */
import { env } from './env';
import { getSession } from './session';

/** What went wrong, in words a person can act on. */
export class DownloadFailed extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      status === 403
        ? 'You are not allowed to download this file.'
        : status === 404
          ? 'That file no longer exists.'
          : status === 409
            ? 'That file does not exist yet. A bank file is only made once the run has been approved.'
            : 'The download failed. Please try again.',
    );
    this.name = 'DownloadFailed';
    this.status = status;
  }
}

/**
 * Fetches a file from the API and saves it under `fileName`.
 *
 * `path` is the part after `/api/v1`, already encoded — for example
 * `/payroll/runs/<id>/bank-export`.
 */
export async function downloadFromApi(path: string, fileName: string): Promise<void> {
  const session = getSession();
  const response = await fetch(`${env.apiBaseUrl}${path}`, {
    credentials: 'include',
    headers: session === null ? {} : { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) {
    throw new DownloadFailed(response.status);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Released straight away: a payslip or a bank file should not linger.
    URL.revokeObjectURL(url);
  }
}
