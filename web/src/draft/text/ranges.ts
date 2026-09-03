import { graphemeBoundaries, tokenizeText } from "./tokenize";
import type { TextSelection, TextUnit } from "./types";

const EMPTY_UNIT: TextUnit = {
  kind: "word",
  start: 0,
  end: 0,
  text: "",
};

export function cursorUnits(text: string): readonly TextUnit[] {
  const units = tokenizeText(text);
  return units.length ? units : [EMPTY_UNIT];
}

export function unitAtOffset(text: string, offset: number): TextUnit {
  const units = tokenizeText(text);
  if (!units.length) return EMPTY_UNIT;
  const safe = Math.max(0, Math.min(text.length, offset));
  return (
    units.find(({ start, end }) => start <= safe && safe < end) ??
    units.find(({ start }) => start >= safe) ??
    units[units.length - 1]!
  );
}

export function adjacentUnit(
  text: string,
  offset: number,
  direction: "up" | "down",
): TextUnit {
  const units = cursorUnits(text);
  const current = unitAtOffset(text, offset);
  const index = Math.max(
    0,
    units.findIndex(
      ({ start, end }) => start === current.start && end === current.end,
    ),
  );
  return units[
    Math.max(
      0,
      Math.min(units.length - 1, index + (direction === "up" ? -1 : 1)),
    )
  ]!;
}

export function selectionRange(
  text: string,
  selection: TextSelection,
): Readonly<{ start: number; end: number }> {
  const anchor = unitAtOffset(text, selection.anchorOffset);
  const focus = unitAtOffset(text, selection.focusOffset);
  return {
    start: Math.min(anchor.start, focus.start),
    end: Math.max(anchor.end, focus.end),
  };
}

export function dwRange(
  text: string,
  offset: number,
): Readonly<{ start: number; end: number }> | null {
  const units = tokenizeText(text);
  if (!units.length) return null;
  const current = unitAtOffset(text, offset);
  const index = units.findIndex(
    ({ start, end }) => start === current.start && end === current.end,
  );
  return {
    start: current.start,
    end: units[index + 1]?.start ?? text.length,
  };
}

export function normalizeTextRange(
  text: string,
  start: number,
  end: number,
): Readonly<{ start: number; end: number }> {
  const low = Math.max(0, Math.min(text.length, Math.min(start, end)));
  const high = Math.max(0, Math.min(text.length, Math.max(start, end)));
  const boundaries = graphemeBoundaries(text);
  const normalizedStart =
    [...boundaries].reverse().find((boundary) => boundary <= low) ?? 0;
  return {
    start: normalizedStart,
    end:
      low === high
        ? normalizedStart
        : (boundaries.find((boundary) => boundary >= high) ?? text.length),
  };
}

export function reanchorTextCursor(text: string, offset: number): number {
  return unitAtOffset(text, offset).start;
}

export function replaceTextRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): Readonly<{ text: string; cursorOffset: number; replaced: string }> {
  const range = normalizeTextRange(text, start, end);
  const next = text.slice(0, range.start) + replacement + text.slice(range.end);
  return {
    text: next,
    cursorOffset: reanchorTextCursor(next, range.start + replacement.length),
    replaced: text.slice(range.start, range.end),
  };
}

export function insertCommittedText(
  text: string,
  cursorOffset: number,
  committed: string,
): Readonly<{ text: string; cursorOffset: number }> {
  const boundary = normalizeTextRange(text, cursorOffset, cursorOffset).start;
  const edit = replaceTextRange(text, boundary, boundary, committed);
  return { text: edit.text, cursorOffset: edit.cursorOffset };
}
