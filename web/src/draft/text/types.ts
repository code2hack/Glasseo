import type { SemanticInput } from "../../native/semanticInput";

export type TextUnit = Readonly<{
  kind: "word" | "punctuation";
  start: number;
  end: number;
  text: string;
}>;

export type TextSelection = Readonly<{
  anchorOffset: number;
  focusOffset: number;
}>;

export type TextEditorState = Readonly<{
  text: string;
  cursorOffset: number;
  selection: TextSelection | null;
  copyBuffer: string;
  handledInteractionIds: readonly number[];
}>;

export type TextEditorAction =
  | SemanticInput
  | Readonly<{ type: "replace-text"; text: string; cursorOffset?: number }>
  | Readonly<{
      type: "replace-range";
      start: number;
      end: number;
      text: string;
    }>
  | Readonly<{ type: "insert-committed-text"; text: string }>;

export type TextEditorTransition = Readonly<{
  state: TextEditorState;
  handled: boolean;
  persist: boolean;
}>;
