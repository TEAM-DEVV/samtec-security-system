import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The `<option>` elements. */
  children: ReactNode;
}

/** A labelled drop-down, styled once so every filter looks the same. */
export function SelectField({ id, label, value, onChange, children }: SelectFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {children}
      </select>
    </div>
  );
}
