import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SecretPanelProps {
  /** The value shown once, for example a device's signing secret. */
  secret: string;
  /** What it is and where it goes, in one or two sentences. */
  explanation: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Shows a secret the API returns only once, with a Copy button. The page
 * keeps it in memory only; leaving the page is the last chance to copy it.
 */
export function SecretPanel({ secret, explanation }: SecretPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border border-amber-500/40 bg-amber-50/60 p-4 text-sm dark:bg-amber-950/30">
      <p>
        {explanation} It is shown <strong>only now</strong>; SAMTEC keeps only an encrypted copy.
        After you paste it, copy something else so it leaves your clipboard. If Windows clipboard
        history is on, clear it afterwards (Win+V, then Clear all).
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="one-time-secret">Secret</Label>
        <div className="flex gap-2">
          <Input
            id="one-time-secret"
            readOnly
            value={secret}
            onFocus={(event) => event.target.select()}
            className="font-mono text-xs"
          />
          <Button type="button" variant="secondary" onClick={() => void copySecret()}>
            {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p role="status" className="text-muted-foreground text-xs">
          {copyState === 'copied' && 'The secret is on your clipboard.'}
          {copyState === 'failed' &&
            'Copying did not work here. Tap the box, select it all and copy it yourself.'}
        </p>
      </div>
    </div>
  );
}
