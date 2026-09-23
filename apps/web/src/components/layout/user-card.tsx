import type { CurrentUser } from '@samtec/contracts';
import { KeyRound, LogOut } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
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
    <div className="m-3 flex items-center gap-3 rounded-xl border border-sidebar-border bg-white/[0.04] px-3 py-2.5">
      {/* Decorative: the name is right beside it. */}
      <Avatar
        aria-hidden="true"
        className="size-9 ring-2 ring-gold/60 ring-offset-1 ring-offset-sidebar"
      >
        <AvatarFallback className="bg-sidebar-primary font-semibold text-sidebar-primary-foreground text-xs">
          {initials(user.fullName)}
        </AvatarFallback>
      </Avatar>
      <p className="min-w-0 flex-1 text-sm leading-tight">
        <span className="block truncate font-medium">{user.fullName}</span>
        <span className="block truncate text-sidebar-foreground/60 text-xs">
          {roleLabels[user.role]}
        </span>
      </p>
      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        title="Change password"
        className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Link to={routes.changePassword}>
          <KeyRound aria-hidden="true" />
          <span className="sr-only">Change password</span>
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void handleSignOut()}
        title={signingOut ? 'Signing out…' : 'Sign out'}
        className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <LogOut aria-hidden="true" />
        {/* Two icon buttons side by side: the words live in the title and for screen readers. */}
        <span className="sr-only">{signingOut ? 'Signing out…' : 'Sign out'}</span>
      </Button>
    </div>
  );
}
