import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setTheme, type Theme, useTheme } from '@/lib/theme';

const NEXT: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };
const LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };
const ICONS: Record<Theme, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

/** One button that cycles light → dark → system. The text says which is on, not only the icon. */
export function ThemeToggle() {
  const theme = useTheme();
  const Icon = ICONS[theme];
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setTheme(NEXT[theme])}
      title={`Theme: ${LABELS[theme]}. Click to switch.`}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">Theme:</span>
      {LABELS[theme]}
    </Button>
  );
}
