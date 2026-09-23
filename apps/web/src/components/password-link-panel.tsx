import type { PasswordSetup } from '@samtec/contracts';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { routes } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateTime } from '@/lib/format';

interface PasswordLinkPanelProps {
  /** The one-time token and its expiry, from the create or reset response. */
  passwordSetup: PasswordSetup;
  /** Whose link it is, so the administrator hands it to the right person. */
  email: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** The link the person opens to choose their password: `<dashboard>/set-password#token=…`. */
export function passwordLinkFor(token: string): string {
  // The token sits after `#`, which browsers never send to a server, so it
  // stays out of every server log.
  return `${window.location.origin}${routes.setPassword}#token=${encodeURIComponent(token)}`;
}

/**
 * Shows a one-time password link with a Copy button. The API shows the token
 * only in this one response, so the panel says so: once the page is left,
 * the only way to get a new link is Reset sign-in.
 */
export function PasswordLinkPanel({ passwordSetup, email }: PasswordLinkPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const link = passwordLinkFor(passwordSetup.token);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
    } catch {
      // Clipboard access refused (some phones and browsers): say so, the box still works by hand.
      setCopyState('failed');
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-amber-500/40 bg-amber-50/60 p-4 text-sm dark:bg-amber-950/30">
      <p>
        Send this link to <strong>{email}</strong> in person or by private message. It works{' '}
        <strong>once</strong>, until {formatDateTime(passwordSetup.expiresAt)} (Ghana time), and is
        shown only now. After you paste it, copy something else so it leaves your clipboard.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="password-link">One-time password link</Label>
        <div className="flex gap-2">
          <Input
            id="password-link"
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
            className="font-mono text-xs"
          />
          <Button type="button" variant="secondary" onClick={() => void copyLink()}>
            {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p role="status" className="text-muted-foreground text-xs">
          {copyState === 'copied' && 'The link is on your clipboard.'}
          {copyState === 'failed' &&
            'Copying did not work here. Tap the link, select it all and copy it yourself.'}
        </p>
      </div>
    </div>
  );
}
