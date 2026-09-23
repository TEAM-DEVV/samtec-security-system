import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** True when the API complained about this field. */
  invalid?: boolean;
  /** The id of the text that explains this field, for screen readers. */
  describedBy?: string;
  /** The `<option>` elements. */
  children: ReactNode;
}

/** A labelled drop-down, styled once so every filter and form looks the same. */
export function SelectField({
  id,
  label,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
  children,
}: SelectFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive"
      >
        {children}
      </select>
    </div>
  );
}
