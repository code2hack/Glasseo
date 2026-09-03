import assert from "node:assert/strict";
import test from "node:test";
import { runTextAcceptance } from "../src/draft/text/acceptance";
import { projectTextSegments } from "../src/draft/text/presentation";
import {
  adjacentUnit,
  dwRange,
  insertCommittedText,
  normalizeTextRange,
  replaceTextRange,
  selectionRange,
  unitAtOffset,
} from "../src/draft/text/ranges";
import {
  createTextEditorState,
  reduceTextEditor,
  resetTextTransientState,
} from "../src/draft/text/reducer";
import { tokenizeText } from "../src/draft/text/tokenize";
import type { SemanticInput } from "../src/native/semanticInput";

test("tokenizer preserves Unicode words and emits grapheme punctuation", () => {
  const text =
    "don't snake_case rock’n’roll foo' bar-zip 中文 Cafe\u0301 👩🏽‍💻 🇸🇬 1️⃣!";
  assert.deepEqual(
    tokenizeText(text).map(({ kind, text }) => [kind, text]),
    [
      ["word", "don't"],
      ["word", "snake_case"],
      ["word", "rock’n’roll"],
      ["word", "foo"],
      ["punctuation", "'"],
      ["word", "bar"],
      ["punctuation", "-"],
      ["word", "zip"],
      ["word", "中文"],
      ["word", "Cafe\u0301"],
      ["punctuation", "👩🏽‍💻"],
      ["punctuation", "🇸🇬"],
      ["punctuation", "1️⃣"],
      ["punctuation", "!"],
    ],
  );
  assert.deepEqual(tokenizeText(" \t\n"), []);
});

test("all offsets re-anchor without splitting surrogate or combining sequences", () => {
  const text = "a 👩🏽‍💻 Cafe\u0301!";
  for (let offset = -1; offset <= text.length + 1; offset++) {
    const unit = unitAtOffset(text, offset);
    assert.equal(text.slice(unit.start, unit.end), unit.text);
    assert.equal(isLowSurrogate(text.charCodeAt(unit.start)), false);
    assert.equal(/^\p{M}/u.test(unit.text), false);
  }
  const emoji = tokenizeText(text)[1]!;
  assert.deepEqual(normalizeTextRange(text, emoji.start + 1, emoji.end - 1), {
    start: emoji.start,
    end: emoji.end,
  });
  const inserted = insertCommittedText(text, emoji.start + 1, "ok ");
  assert.equal(inserted.text, "a ok 👩🏽‍💻 Cafe\u0301!");
});

test("movement clamps, selection ranges are inclusive, and dw is exact", () => {
  const text = "one,  two\nthree";
  assert.equal(adjacentUnit(text, 0, "up").text, "one");
  assert.equal(adjacentUnit(text, 0, "down").text, ",");
  assert.equal(adjacentUnit(text, text.length, "down").text, "three");
  assert.deepEqual(selectionRange(text, { anchorOffset: 6, focusOffset: 0 }), {
    start: 0,
    end: 9,
  });
  assert.deepEqual(dwRange(text, 3), { start: 3, end: 6 });
  assert.deepEqual(dwRange(text, text.length), { start: 10, end: 15 });
  assert.equal(dwRange(" \n ", 0), null);
  assert.deepEqual(replaceTextRange(text, 3, 6, ""), {
    text: "onetwo\nthree",
    cursorOffset: 0,
    replaced: ",  ",
  });
});

test("reducer moves once per BEGIN and expands, contracts, reverses, then copies", () => {
  let state = createTextEditorState("one two three", 4);
  state = reduceTextEditor(state, input("PRIMARY", "SHORT", 1)).state;
  state = reduceTextEditor(state, input("DOWN", "BEGIN", 2)).state;
  assert.deepEqual(state.selection, { anchorOffset: 4, focusOffset: 8 });
  assert.equal(
    reduceTextEditor(state, input("DOWN", "UPDATE", 2)).handled,
    false,
  );
  assert.equal(reduceTextEditor(state, input("DOWN", "BEGIN", 2)).state, state);
  state = reduceTextEditor(state, input("UP", "BEGIN", 3)).state;
  state = reduceTextEditor(state, input("UP", "BEGIN", 4)).state;
  assert.deepEqual(state.selection, { anchorOffset: 4, focusOffset: 0 });
  const copied = reduceTextEditor(state, input("PRIMARY", "SHORT", 5));
  assert.equal(copied.handled, true);
  assert.equal(copied.persist, false);
  assert.equal(copied.state.copyBuffer, "one two");
  assert.equal(copied.state.selection, null);
  assert.equal(copied.state.cursorOffset, 0);
});

test("only long SECONDARY cuts or deletes and edits are atomic", () => {
  let state = createTextEditorState("one,  two three", 3);
  for (const action of ["SHORT", "DOUBLE"] as const) {
    const ignored = reduceTextEditor(state, input("SECONDARY", action, 10));
    assert.equal(ignored.handled, false);
    assert.equal(ignored.state, state);
  }
  for (const [control, action] of [
    ["PRIMARY", "LONG"],
    ["LEFT", "BEGIN"],
    ["RIGHT", "BEGIN"],
    ["COMMAND", "SHORT"],
  ] as const)
    assert.equal(
      reduceTextEditor(state, input(control, action, 10)).handled,
      false,
    );
  state = reduceTextEditor(state, input("SECONDARY", "LONG", 11)).state;
  assert.equal(state.text, "onetwo three");
  assert.equal(state.cursorOffset, 0);
  assert.equal(state.copyBuffer, "");

  state = createTextEditorState("one two three", 4);
  state = reduceTextEditor(state, input("PRIMARY", "SHORT", 12)).state;
  state = reduceTextEditor(state, input("DOWN", "BEGIN", 13)).state;
  const cut = reduceTextEditor(state, input("SECONDARY", "LONG", 14));
  assert.equal(cut.persist, true);
  assert.equal(cut.state.text, "one ");
  assert.equal(cut.state.cursorOffset, 0);
  assert.equal(cut.state.copyBuffer, "two three");
  assert.equal(cut.state.selection, null);
});

test("empty edits no-op safely and committed replacement resets transient state", () => {
  let state = createTextEditorState(" \n ", 2);
  state = reduceTextEditor(state, input("SECONDARY", "LONG", 1)).state;
  assert.equal(state.text, " \n ");
  assert.equal(state.cursorOffset, 0);
  state = reduceTextEditor(state, {
    type: "insert-committed-text",
    text: "hello",
  }).state;
  assert.equal(state.text, "hello \n ");
  state = {
    ...state,
    copyBuffer: "secret",
    selection: { anchorOffset: 0, focusOffset: 0 },
  };
  assert.deepEqual(resetTextTransientState(state), {
    ...state,
    selection: null,
    copyBuffer: "",
  });
});

test("projection preserves whitespace, exposes keyed cursor state, and contains no HTML", () => {
  let state = createTextEditorState("<b>one</b>\n👩🏽‍💻", 3);
  state = reduceTextEditor(state, input("PRIMARY", "SHORT", 1)).state;
  const segments = projectTextSegments(state, 7);
  assert.equal(segments.map(({ text }) => text).join(""), state.text);
  assert.equal(segments.filter(({ selected }) => selected).length, 1);
  assert.equal(
    segments.some(({ kind, text }) => kind === "whitespace" && text === "\n"),
    true,
  );
  assert.equal(
    segments.every(({ key }) => key.startsWith("7:")),
    true,
  );
  assert.equal("html" in segments[0]!, false);
  assert.equal(
    projectTextSegments(createTextEditorState(""), 8)[0]?.cursor,
    true,
  );
});

test("standalone Text acceptance harness passes without exposing content", () => {
  const result = runTextAcceptance();
  assert.equal(result.passed, true);
  assert.deepEqual(Object.keys(result), [
    "passed",
    "unitCount",
    "cursorOffset",
    "selectionActive",
    "copyLength",
    "textLength",
  ]);
});

function input(
  control: SemanticInput["control"],
  action: SemanticInput["action"],
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  };
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
