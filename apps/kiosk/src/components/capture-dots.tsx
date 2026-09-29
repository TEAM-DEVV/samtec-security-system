/**
 * Three dots for the three enrollment captures.
 *
 * "Capture 2 of 3" inside a sentence is easy to miss, especially for the
 * administrator holding the phone while talking to the worker in front of them.
 * Three dots filling up is not.
 *
 * The words stay beside it: this is a picture of the same fact, never the only
 * place the fact appears.
 */
export function CaptureDots({ taken, needed }: { taken: number; needed: number }) {
  // Numbered rather than indexed, so each dot keeps its own identity as the
  // captures progress and the breathing animation does not jump between them.
  const dots = Array.from({ length: needed }, (_unused, index) => index + 1);

  return (
    <div className="dots" aria-hidden="true">
      {dots.map((number) => {
        const done = number <= taken;
        const now = number === taken + 1;
        return (
          <span
            key={`capture-${number}`}
            className={`dots__dot${done ? ' dots__dot--done' : now ? ' dots__dot--now' : ''}`}
          />
        );
      })}
    </div>
  );
}
