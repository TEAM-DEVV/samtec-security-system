import type { CurrentUser } from '@samtec/contracts';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth';
import { initials } from '@/lib/format';
import { roleLabels } from '@/lib/roles';

/** Who is signed in, with a Sign out button. Lives at the bottom of the sidebar and the mobile menu. */
export function UserCard({ user }: { user: CurrentUser }) {
  const [signingOut, setSigningOut] = useState(false);

  // Once the session is cleared, `RequireSession` (which wraps the shell)
  // sends the user to the sign-in page; nothing to navigate here.
  async function handleSignOut() {
    // Ignore extra clicks while the API is being told. The button stays
    // enabled, so keyboard users never lose their place.
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="flex items-center gap-3 border-sidebar-border border-t px-4 py-3">
      {/* Decorative: the name is right beside it. */}
      <Avatar aria-hidden="true" className="size-9 border border-sidebar-border">
        <AvatarFallback className="bg-sidebar-primary font-semibold text-sidebar-primary-foreground text-xs">
          {initials(user.fullName)}
        </AvatarFallback>
      </Avatar>
      <p className="min-w-0 flex-1 text-sm leading-tight">
        <span className="block truncate font-medium">{user.fullName}</span>
        <span className="block truncate text-sidebar-foreground/70 text-xs">
          {roleLabels[user.role]}
        </span>
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleSignOut()}
        title={signingOut ? 'Signing out…' : 'Sign out'}
        className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <LogOut aria-hidden="true" />
        {/* The word shows where there is room; the sr-only copy covers icon-only widths. */}
        <span className="sr-only sm:not-sr-only">{signingOut ? 'Signing out…' : 'Sign out'}</span>
      </Button>
    </div>
  );
}
