export type DiffLine =
  | { readonly kind: "same"; readonly text: string }
  | { readonly kind: "added"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string };

export const MAX_DIFF_LINES = 1_500;

/**
 * Line diff between an earlier and a later text. Returns null when either
 * side is too large to compare within a fixed work bound.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return null;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const width = middleB.length + 1;
  const table = new Uint16Array((middleA.length + 1) * width);
  for (let row = middleA.length - 1; row >= 0; row -= 1) {
    for (let column = middleB.length - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        middleA[row] === middleB[column]
          ? (table[(row + 1) * width + column + 1] as number) + 1
          : Math.max(
              table[(row + 1) * width + column] as number,
              table[row * width + column + 1] as number,
            );
    }
  }
  const result: DiffLine[] = a
    .slice(0, start)
    .map((text) => ({ kind: "same", text }));
  let row = 0;
  let column = 0;
  while (row < middleA.length && column < middleB.length) {
    if (middleA[row] === middleB[column]) {
      result.push({ kind: "same", text: middleA[row] as string });
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * width + column] as number) >=
      (table[row * width + column + 1] as number)
    ) {
      result.push({ kind: "removed", text: middleA[row] as string });
      row += 1;
    } else {
      result.push({ kind: "added", text: middleB[column] as string });
      column += 1;
    }
  }
  while (row < middleA.length) {
    result.push({ kind: "removed", text: middleA[row] as string });
    row += 1;
  }
  while (column < middleB.length) {
    result.push({ kind: "added", text: middleB[column] as string });
    column += 1;
  }
  for (const text of a.slice(endA)) {
    result.push({ kind: "same", text });
  }
  return result;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n");
}

export function hasChanges(diff: readonly DiffLine[]): boolean {
  return diff.some((line) => line.kind !== "same");
}
