import { createTextEditorState, reduceTextEditor } from "./reducer";
import { tokenizeText } from "./tokenize";
import type { TextEditorState } from "./types";

export type TextAcceptanceResult = Readonly<{
  passed: boolean;
  unitCount: number;
  cursorOffset: number;
  selectionActive: boolean;
  copyLength: number;
  textLength: number;
}>;

export function runTextAcceptance(): TextAcceptanceResult {
  let state = createTextEditorState("alpha, beta\nCafe\u0301 👩🏽‍💻", 0);
  state = input(state, "DOWN", "BEGIN", 1);
  state = input(state, "PRIMARY", "SHORT", 2);
  state = input(state, "DOWN", "BEGIN", 3);
  state = input(state, "SECONDARY", "LONG", 4);
  const result = {
    passed:
      state.text === "alpha\nCafe\u0301 👩🏽‍💻" && state.copyBuffer === ", beta",
    unitCount: tokenizeText(state.text).length,
    cursorOffset: state.cursorOffset,
    selectionActive: state.selection !== null,
    copyLength: state.copyBuffer.length,
    textLength: state.text.length,
  };
  return result;
}

function input(
  state: TextEditorState,
  control: "PRIMARY" | "SECONDARY" | "DOWN",
  action: "BEGIN" | "SHORT" | "LONG",
  interactionId: number,
): TextEditorState {
  return reduceTextEditor(state, {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  }).state;
}
