import type { SemanticInput } from "../../native/semanticInput";
import {
  adjacentUnit,
  dwRange,
  insertCommittedText,
  reanchorTextCursor,
  replaceTextRange,
  selectionRange,
  unitAtOffset,
} from "./ranges";
import type {
  TextEditorAction,
  TextEditorState,
  TextEditorTransition,
} from "./types";

export function createTextEditorState(
  text: string,
  cursorOffset = 0,
): TextEditorState {
  return {
    text,
    cursorOffset: reanchorTextCursor(text, cursorOffset),
    selection: null,
    copyBuffer: "",
    handledInteractionIds: [],
  };
}

export function resetTextTransientState(
  state: TextEditorState,
): TextEditorState {
  return { ...state, selection: null, copyBuffer: "" };
}

export function reduceTextEditor(
  state: TextEditorState,
  action: TextEditorAction,
): TextEditorTransition {
  if (action.type === "replace-text") {
    const cursorOffset = reanchorTextCursor(
      action.text,
      action.cursorOffset ?? state.cursorOffset,
    );
    const next = {
      ...state,
      text: action.text,
      cursorOffset,
      selection: null,
    };
    return changed(state, next, true);
  }
  if (action.type === "replace-range") {
    const edit = replaceTextRange(
      state.text,
      action.start,
      action.end,
      action.text,
    );
    const next = { text: edit.text, cursorOffset: edit.cursorOffset };
    return changed(state, { ...state, ...next, selection: null }, true);
  }
  if (action.type === "insert-committed-text") {
    const edit = insertCommittedText(
      state.text,
      state.cursorOffset,
      action.text,
    );
    return changed(state, { ...state, ...edit, selection: null }, true);
  }
  if (!isTextEditorInput(action))
    return { state, handled: false, persist: false };
  if (state.handledInteractionIds.includes(action.interactionId))
    return { state, handled: true, persist: false };

  const next =
    action.action === "BEGIN"
      ? move(state, action.control)
      : action.control === "PRIMARY"
        ? selectOrCopy(state)
        : cutOrDelete(state);
  return changed(state, remember(next, action.interactionId), true);
}

export function isTextEditorInput(
  action: SemanticInput,
): action is SemanticInput &
  (
    | Readonly<{ control: "UP" | "DOWN"; action: "BEGIN" }>
    | Readonly<{ control: "PRIMARY"; action: "SHORT" }>
    | Readonly<{ control: "SECONDARY"; action: "LONG" }>
  ) {
  return (
    (action.action === "BEGIN" &&
      (action.control === "UP" || action.control === "DOWN")) ||
    (action.action === "SHORT" && action.control === "PRIMARY") ||
    (action.action === "LONG" && action.control === "SECONDARY")
  );
}

function move(state: TextEditorState, control: "UP" | "DOWN"): TextEditorState {
  const offset = state.selection?.focusOffset ?? state.cursorOffset;
  const target = adjacentUnit(
    state.text,
    offset,
    control === "UP" ? "up" : "down",
  ).start;
  return state.selection
    ? {
        ...state,
        cursorOffset: target,
        selection: { ...state.selection, focusOffset: target },
      }
    : { ...state, cursorOffset: target };
}

function selectOrCopy(state: TextEditorState): TextEditorState {
  if (!state.selection) {
    const offset = unitAtOffset(state.text, state.cursorOffset).start;
    return {
      ...state,
      cursorOffset: offset,
      selection: { anchorOffset: offset, focusOffset: offset },
    };
  }
  const range = selectionRange(state.text, state.selection);
  return {
    ...state,
    cursorOffset: unitAtOffset(state.text, state.selection.focusOffset).start,
    selection: null,
    copyBuffer: state.text.slice(range.start, range.end),
  };
}

function cutOrDelete(state: TextEditorState): TextEditorState {
  const range = state.selection
    ? selectionRange(state.text, state.selection)
    : dwRange(state.text, state.cursorOffset);
  if (!range) return { ...state, selection: null };
  const edit = replaceTextRange(state.text, range.start, range.end, "");
  return {
    ...state,
    text: edit.text,
    cursorOffset: edit.cursorOffset,
    selection: null,
    copyBuffer: state.selection ? edit.replaced : state.copyBuffer,
  };
}

function remember(
  state: TextEditorState,
  interactionId: number,
): TextEditorState {
  return {
    ...state,
    // ponytail: 64 IDs cover native replay; persist a ledger only if replay spans sessions.
    handledInteractionIds: [
      ...state.handledInteractionIds.slice(-63),
      interactionId,
    ],
  };
}

function changed(
  previous: TextEditorState,
  state: TextEditorState,
  handled: boolean,
): TextEditorTransition {
  return {
    state,
    handled,
    persist:
      previous.text !== state.text ||
      previous.cursorOffset !== state.cursorOffset,
  };
}
