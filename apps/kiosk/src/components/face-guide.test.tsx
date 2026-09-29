import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CaptureDots } from './capture-dots';
import { FaceGuide } from './face-guide';
import { OutcomeMark } from './outcome-mark';

/**
 * The drawn parts of the kiosk.
 *
 * These are tested rather than eyeballed because of what they are for: at a gate,
 * the shape on screen is the only instruction a guard gets who does not stop to
 * read the sentence. An arrow pointing the wrong way sends every person the wrong
 * way, and a screenshot review would not catch it — the picture looks fine either
 * way round unless you know the camera is mirrored.
 *
 * The house rule these enforce: **nothing is said by colour alone.** Every state
 * changes a shape as well as a colour, because a sun-bleached screen and colour
 * blindness are the same problem at a gate.
 */
describe('FaceGuide', () => {
  it('draws a dashed oval while it is waiting for a face', () => {
    const { container } = render(<FaceGuide state="waiting" />);
    const oval = container.querySelector('.guide__oval');
    // Dashed, not just grey: the difference from "found you" has to be visible
    // without colour.
    expect(oval?.getAttribute('stroke-dasharray')).toBe('7 7');
  });

  it('draws a solid oval once it has something to look at', () => {
    for (const state of ['turn', 'centre', 'good', 'bad'] as const) {
      const { container } = render(<FaceGuide state={state} />);
      expect(container.querySelector('.guide__oval')?.getAttribute('stroke-dasharray')).toBeNull();
    }
  });

  it('mirrors the arrow, because the camera image is mirrored', () => {
    const { container: left } = render(<FaceGuide state="turn" turn="LEFT" />);
    const { container: right } = render(<FaceGuide state="turn" turn="RIGHT" />);

    // The camera is mirrored so that turning your head left moves the image
    // left. The arrow has to be mirrored with it, or it points the wrong way and
    // every person turns the wrong way the first time.
    expect(left.querySelector('.guide__arrow')?.getAttribute('transform')).toBe('');
    expect(right.querySelector('.guide__arrow')?.getAttribute('transform')).toBe(
      'translate(120 0) scale(-1 1)',
    );
  });

  it('shows no arrow when it is not asking for a turn', () => {
    for (const state of ['waiting', 'centre', 'good', 'bad'] as const) {
      const { container } = render(<FaceGuide state={state} turn="LEFT" />);
      // `centre` draws eye-marks rather than an arrow, so only `waiting`, `good`
      // and `bad` are truly empty.
      const arrow = container.querySelector('.guide__arrow');
      if (state === 'centre') {
        expect(arrow).not.toBeNull();
      } else {
        expect(arrow).toBeNull();
      }
    }
  });

  it('runs the time ring down, so a person can see they are not stuck', () => {
    const { container: fresh } = render(<FaceGuide state="turn" turn="LEFT" progress={0} />);
    const { container: nearlyOut } = render(<FaceGuide state="turn" turn="LEFT" progress={0.9} />);

    const offset = (root: Element) =>
      Number(root.querySelector('.guide__ring')?.getAttribute('stroke-dashoffset') ?? '0');
    expect(offset(fresh)).toBeLessThan(offset(nearlyOut));
  });

  it('carries no text, so nothing here can leak a name or a score', () => {
    const { container } = render(<FaceGuide state="good" />);
    expect(container.textContent).toBe('');
    // And it is hidden from screen readers, because the words beside it say the
    // same thing and would otherwise be read twice.
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('OutcomeMark', () => {
  it('draws a different shape for each answer, not just a different colour', () => {
    const shapes = (['good', 'bad', 'waiting'] as const).map((outcome) => {
      const { container } = render(<OutcomeMark outcome={outcome} />);
      return container.querySelector('.outcome__stroke')?.getAttribute('d');
    });
    // Three distinct paths: a tick, a cross and a clock hand.
    expect(new Set(shapes).size).toBe(3);
    expect(shapes.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
  });

  it('is decorative, because the words beside it carry the meaning', () => {
    const { container } = render(<OutcomeMark outcome="bad" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).toBe('');
  });
});

describe('CaptureDots', () => {
  it('fills one dot per capture taken, and marks the one in progress', () => {
    const { container } = render(<CaptureDots taken={1} needed={3} />);
    expect(container.querySelectorAll('.dots__dot')).toHaveLength(3);
    expect(container.querySelectorAll('.dots__dot--done')).toHaveLength(1);
    expect(container.querySelectorAll('.dots__dot--now')).toHaveLength(1);
  });

  it('marks nothing as in progress once every capture is taken', () => {
    const { container } = render(<CaptureDots taken={3} needed={3} />);
    expect(container.querySelectorAll('.dots__dot--done')).toHaveLength(3);
    expect(container.querySelectorAll('.dots__dot--now')).toHaveLength(0);
  });
});
