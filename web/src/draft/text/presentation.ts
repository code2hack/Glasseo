import { selectionRange, unitAtOffset } from "./ranges";
import { tokenizeText } from "./tokenize";
import type { TextEditorState, TextUnit } from "./types";

export type TextSegment = Readonly<{
  key: string;
  kind: "whitespace" | TextUnit["kind"];
  start: number;
  end: number;
  text: string;
  cursor: boolean;
  selected: boolean;
}>;

export function projectTextSegments(
  state: TextEditorState,
  textRevision: number,
): readonly TextSegment[] {
  const units = tokenizeText(state.text);
  if (!units.length)
    return [
      {
        key: `${textRevision}:empty:0`,
        kind: "word",
        start: 0,
        end: 0,
        text: "",
        cursor: true,
        selected: !!state.selection,
      },
    ];
  const selection = state.selection
    ? selectionRange(state.text, state.selection)
    : null;
  const cursor = unitAtOffset(state.text, state.cursorOffset);
  const result: TextSegment[] = [];
  let offset = 0;
  let occurrence = 0;
  for (const unit of units) {
    if (offset < unit.start)
      result.push(
        segment(
          state.text,
          offset,
          unit.start,
          "whitespace",
          textRevision,
          occurrence++,
        ),
      );
    result.push({
      ...unit,
      key: `${textRevision}:${unit.start}:${unit.end}:${occurrence++}`,
      cursor: !selection && unit.start === cursor.start,
      selected:
        !!selection && unit.start < selection.end && unit.end > selection.start,
    });
    offset = unit.end;
  }
  if (offset < state.text.length)
    result.push(
      segment(
        state.text,
        offset,
        state.text.length,
        "whitespace",
        textRevision,
        occurrence,
      ),
    );
  return result;
}

function segment(
  text: string,
  start: number,
  end: number,
  kind: "whitespace",
  revision: number,
  occurrence: number,
): TextSegment {
  return {
    key: `${revision}:${start}:${end}:${occurrence}`,
    kind,
    start,
    end,
    text: text.slice(start, end),
    cursor: false,
    selected: false,
  };
}
