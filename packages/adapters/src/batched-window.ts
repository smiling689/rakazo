export type BatchedWindowLimits = { turns: number; items: number; size: number };

/**
 * Index of the oldest item still inside a window over items in prompt order (`turn` groups one
 * message's or one turn's items).
 *
 * A window of the newest items would rewrite one older message on every new item, and with it
 * the cached prompt from there on. Instead the start stays put until the items after it break a
 * limit, then jumps forward to the newest that fit half of every limit, so the prompt is
 * rewritten about once per several turns. It is replayed from the first item, so consecutive
 * turns of a thread agree without storing anything.
 */
export function batchedWindowStart(
  slots: readonly { turn: number; size: number }[],
  limits: BatchedWindowLimits,
): number {
  const half: BatchedWindowLimits = {
    turns: Math.ceil(limits.turns / 2),
    items: Math.ceil(limits.items / 2),
    size: Math.ceil(limits.size / 2),
  };
  const fits = (from: number, to: number, cap: BatchedWindowLimits) => {
    let turns = 0;
    let size = 0;
    for (let index = from; index <= to; index += 1) {
      const slot = slots[index]!;
      if (index === from || slot.turn !== slots[index - 1]!.turn) turns += 1;
      size += slot.size;
    }
    return turns <= cap.turns && to - from + 1 <= cap.items && size <= cap.size;
  };
  let start = 0;
  for (let end = 0; end < slots.length; end += 1) {
    if (fits(start, end, limits)) continue;
    // The newest item always stays; older ones join while half of each limit holds.
    start = end;
    while (start > 0 && fits(start - 1, end, half)) start -= 1;
  }
  return start;
}
