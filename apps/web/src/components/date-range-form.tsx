import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { daysBetween, MAX_RANGE_DAYS } from '@/lib/attendance';
import { todayInGhana } from '@/lib/format';

export interface DateRange {
  from: string;
  to: string;
}

interface DateRangeFormProps {
  /** Makes the field ids unique when two forms share a page. */
  idPrefix: string;
  initial: DateRange;
  /** Called with a range the contract accepts (in order, at most 31 days). */
  onApply: (range: DateRange) => void;
}

/**
 * From / To calendar dates with a "Show days" button. The attendance pages
 * share it, so the contract's 31-day rule is checked in one place.
 */
export function DateRangeForm({ idPrefix, initial, onApply }: DateRangeFormProps) {
  const today = todayInGhana();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [mistake, setMistake] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const days = daysBetween(from, to);
    if (Number.isNaN(days) || days < 0) {
      setMistake('The last day must be on or after the first day.');
      return;
    }
    if (days > MAX_RANGE_DAYS) {
      setMistake(`Choose at most ${MAX_RANGE_DAYS} days at a time.`);
      return;
    }
    setMistake(null);
    onApply({ from, to });
  }

  const hintId = `${idPrefix}-range-hint`;

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-from`}>From</Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={from}
          max={today}
          onChange={(event) => setFrom(event.target.value)}
          aria-invalid={mistake !== null || undefined}
          aria-describedby={hintId}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-to`}>To</Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={to}
          max={today}
          onChange={(event) => setTo(event.target.value)}
          aria-invalid={mistake !== null || undefined}
          aria-describedby={hintId}
        />
      </div>
      <Button type="submit" variant="secondary">
        Show days
      </Button>
      <p
        id={hintId}
        className={
          mistake ? 'w-full text-destructive text-xs' : 'w-full text-muted-foreground text-xs'
        }
      >
        {mistake ?? `Up to ${MAX_RANGE_DAYS} days at a time, in Ghana dates.`}
      </p>
    </form>
  );
}
