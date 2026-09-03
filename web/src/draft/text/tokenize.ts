import type { TextUnit } from "./types";

type Grapheme = Readonly<{ start: number; end: number; text: string }>;

const WORD = /^[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;
const CONNECTOR = /^[\p{Pc}'’ʼ]$/u;
const WHITESPACE = /^\s+$/u;

export function tokenizeText(text: string): readonly TextUnit[] {
  const graphemes = scanGraphemes(text);
  const units: TextUnit[] = [];
  for (let index = 0; index < graphemes.length; ) {
    const grapheme = graphemes[index]!;
    if (WHITESPACE.test(grapheme.text)) {
      index++;
      continue;
    }
    if (!isWord(grapheme.text)) {
      units.push({ ...grapheme, kind: "punctuation" });
      index++;
      continue;
    }
    const start = grapheme.start;
    let end = grapheme.end;
    index++;
    while (index < graphemes.length) {
      const current = graphemes[index]!;
      if (isWord(current.text)) {
        end = current.end;
        index++;
        continue;
      }
      if (
        CONNECTOR.test(current.text) &&
        isWord(graphemes[index + 1]?.text ?? "")
      ) {
        end = graphemes[index + 1]!.end;
        index += 2;
        continue;
      }
      break;
    }
    units.push({ kind: "word", start, end, text: text.slice(start, end) });
  }
  return units;
}

export function graphemeBoundaries(text: string): readonly number[] {
  const scanned = scanGraphemes(text);
  return [0, ...scanned.map(({ end }) => end)];
}

function scanGraphemes(text: string): readonly Grapheme[] {
  let offset = 0;
  const points = [...text].map((value) => {
    const point = { value, start: offset };
    offset += value.length;
    return point;
  });
  const result: Grapheme[] = [];
  for (let index = 0; index < points.length; ) {
    const start = points[index]!.start;
    const first = points[index]!.value.codePointAt(0)!;
    index++;
    if (first === 0x0d && codePoint(points[index]) === 0x0a) index++;
    else if (
      isRegionalIndicator(first) &&
      isRegionalIndicator(codePoint(points[index]))
    )
      index++;
    index = consumeExtensions(points, index);
    while (codePoint(points[index]) === 0x200d && points[index + 1]) {
      index += 2;
      index = consumeExtensions(points, index);
    }
    const end = points[index]?.start ?? text.length;
    result.push({ start, end, text: text.slice(start, end) });
  }
  return result;
}

function consumeExtensions(
  points: readonly Readonly<{ value: string; start: number }>[],
  from: number,
): number {
  let index = from;
  while (points[index] && isExtension(points[index]!.value)) index++;
  return index;
}

function isWord(value: string): boolean {
  return WORD.test(value) && !value.includes("\u20e3");
}

function isExtension(value: string): boolean {
  const point = value.codePointAt(0)!;
  return (
    MARK.test(value) ||
    point === 0x20e3 ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0x1f3fb && point <= 0x1f3ff) ||
    (point >= 0xe0020 && point <= 0xe007f)
  );
}

function codePoint(value: Readonly<{ value: string }> | undefined): number {
  return value?.value.codePointAt(0) ?? -1;
}

function isRegionalIndicator(point: number): boolean {
  return point >= 0x1f1e6 && point <= 0x1f1ff;
}
