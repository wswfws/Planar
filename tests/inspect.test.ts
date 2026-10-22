import { describe, expect, it } from 'vitest';
import { measure } from '../src/core/overlay';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('measure', () => {
  it('gives the gap between two boxes side by side', () => {
    const s = measure(box(0, 0, 100, 50), box(120, 10, 40, 20));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ value: 20, y1: 20, x1: 100, x2: 120 });
  });

  it('gives gaps in both directions, whichever box comes first', () => {
    expect(measure(box(0, 0, 10, 10), box(0, 30, 10, 10))[0].value).toBe(20);
    expect(measure(box(0, 30, 10, 10), box(0, 0, 10, 10))[0].value).toBe(20);
    expect(measure(box(50, 0, 10, 10), box(0, 0, 20, 10))[0].value).toBe(30);
  });

  it('gives the padding when one box holds the other', () => {
    const s = measure(box(10, 20, 30, 40), box(0, 0, 100, 100));
    expect(s.map((x) => x.value).sort((a, b) => a - b)).toEqual([10, 20, 40, 60]);
    // Same result with the arguments swapped.
    expect(measure(box(0, 0, 100, 100), box(10, 20, 30, 40)).map((x) => x.value).sort((a, b) => a - b)).toEqual([10, 20, 40, 60]);
  });

  it('shows nothing for boxes that only touch or overlap diagonally', () => {
    expect(measure(box(0, 0, 10, 10), box(10, 0, 10, 10))).toEqual([]);
    expect(measure(box(0, 0, 10, 10), box(20, 20, 10, 10))).toEqual([]);
  });
});
