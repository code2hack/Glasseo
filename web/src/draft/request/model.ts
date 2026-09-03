import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { SemanticInput } from "../../native/semanticInput";
import type { PaseoPermissionRequest } from "../../paseo/adapter";
import {
  REQUEST_ANSWER_VERSION,
  type NormalizedRequest,
  type PreparedRequestResponse,
  type RequestAnswer,
  type RequestAreaSession,
  type RequestKey,
  type RequestSession,
  type RequestUnit,
} from "./types";

export function createRequestArea(
  requests: readonly RequestSession[],
  previous?: RequestAreaSession,
): RequestAreaSession {
  const units = requests.flatMap(({ model }) => model.units);
  return {
    requests,
    cursorUnitId: units.some(({ id }) => id === previous?.cursorUnitId)
      ? (previous?.cursorUnitId ?? null)
      : (units[0]?.id ?? null),
    handledInteractionIds: previous?.handledInteractionIds ?? [],
  };
}

export function reduceRequestAreaInput(
  state: RequestAreaSession,
  input: SemanticInput,
  updatedAt = Date.now(),
): RequestAreaSession {
  if (state.handledInteractionIds.includes(input.interactionId)) return state;
  const units = state.requests.flatMap((session, requestIndex) =>
    session.model.units.map((unit, unitIndex) => ({
      requestIndex,
      unitIndex,
      unit,
    })),
  );
  const current = Math.max(
    0,
    units.findIndex(({ unit }) => unit.id === state.cursorUnitId),
  );
  if (
    (input.control === "UP" || input.control === "DOWN") &&
    input.action === "BEGIN"
  ) {
    const next = clamp(
      current + (input.control === "UP" ? -1 : 1),
      0,
      units.length - 1,
    );
    return rememberArea(
      { ...state, cursorUnitId: units[next]?.unit.id ?? null },
      input.interactionId,
    );
  }
  if (input.control !== "PRIMARY" || input.action !== "SHORT") return state;
  const active = units[current];
  if (!active) return rememberArea(state, input.interactionId);
  const requests = state.requests.map((session, index) =>
    index === active.requestIndex
      ? reduceRequestInput(
          { ...session, cursor: active.unitIndex, handledInteractionIds: [] },
          input,
          updatedAt,
        )
      : session,
  );
  return rememberArea({ ...state, requests }, input.interactionId);
}

export function projectRequest(
  serverId: string,
  agentId: string,
  request: PaseoPermissionRequest,
): NormalizedRequest {
  const units: RequestUnit[] = [];
  request.actions.forEach((action) =>
    units.push({
      id: unitId(request.id, "action", action.id),
      kind: "action",
      requestId: request.id,
      actionId: action.id,
      label: action.label,
      required: true,
    }),
  );
  request.questions.forEach((question, questionIndex) => {
    const fieldId = unitId(request.id, "question", questionIndex);
    question.options.forEach((option) =>
      units.push({
        id: unitId(fieldId, "option", option.id),
        kind: "option",
        requestId: request.id,
        fieldId,
        optionId: option.id,
        label: option.label,
        multiple: question.multiSelect,
        required: !question.allowEmpty,
      }),
    );
    if (question.options.length === 0 || question.allowOther)
      units.push({
        id: unitId(fieldId, "text"),
        kind: "text",
        requestId: request.id,
        fieldId,
        label: question.placeholder ?? question.prompt,
        required: !question.allowEmpty,
      });
  });
  request.suggestions.forEach((suggestion) =>
    units.push({
      id: unitId(request.id, "suggestion", suggestion.id),
      kind: "suggestion",
      requestId: request.id,
      suggestionId: suggestion.id,
      label: suggestion.label,
      required: false,
    }),
  );
  return {
    key: { serverId, agentId, requestId: request.id },
    request,
    fingerprint: requestFingerprint(request),
    units,
    suggestions: request.suggestions,
  };
}

export function createRequestAnswer(
  model: NormalizedRequest,
  updatedAt = Date.now(),
): RequestAnswer {
  return {
    schemaVersion: REQUEST_ANSWER_VERSION,
    key: { ...model.key },
    fingerprint: model.fingerprint,
    selectedActionId: null,
    selectedOptionIds: [],
    selectedSuggestionIds: [],
    fieldTexts: {},
    revision: 0,
    updatedAt,
  };
}

export function createRequestSession(
  model: NormalizedRequest,
  answer = createRequestAnswer(model),
  authoritative = true,
): RequestSession {
  const restored =
    answer.fingerprint === model.fingerprint && sameKey(answer.key, model.key)
      ? answer
      : createRequestAnswer(model);
  return {
    model,
    answer: sanitizeAnswer(restored, model),
    authoritative,
    cursor: 0,
    focusedFieldId: null,
    handledInteractionIds: [],
  };
}

export function reduceRequestInput(
  state: RequestSession,
  input: SemanticInput,
  updatedAt = Date.now(),
): RequestSession {
  if (
    (input.control === "UP" || input.control === "DOWN") &&
    input.action === "BEGIN"
  ) {
    if (state.handledInteractionIds.includes(input.interactionId)) return state;
    const offset = input.control === "UP" ? -1 : 1;
    return remember(
      {
        ...state,
        cursor: clamp(state.cursor + offset, 0, state.model.units.length - 1),
        focusedFieldId: null,
      },
      input.interactionId,
    );
  }
  if (input.control !== "PRIMARY" || input.action !== "SHORT") return state;
  if (state.handledInteractionIds.includes(input.interactionId)) return state;
  const unit = state.model.units[state.cursor];
  if (!unit) return remember(state, input.interactionId);
  if (unit.kind === "text")
    return remember(
      { ...state, focusedFieldId: unit.fieldId },
      input.interactionId,
    );
  const answer = reviseAnswer(
    toggleUnit(state.answer, state.model, unit),
    updatedAt,
  );
  return remember(
    { ...state, answer, focusedFieldId: null },
    input.interactionId,
  );
}

export function replaceFieldText(
  state: RequestSession,
  fieldId: string,
  text: string,
  updatedAt = Date.now(),
): RequestSession {
  const unit = state.model.units.find(
    (candidate) => candidate.kind === "text" && candidate.fieldId === fieldId,
  );
  if (!unit) return state;
  const selectedOptionIds = text.trim()
    ? state.answer.selectedOptionIds.filter(
        (id) =>
          !state.model.units.some(
            (candidate) =>
              candidate.kind === "option" &&
              candidate.fieldId === fieldId &&
              candidate.id === id,
          ),
      )
    : state.answer.selectedOptionIds;
  if (
    state.answer.fieldTexts[fieldId] === text &&
    selectedOptionIds === state.answer.selectedOptionIds
  )
    return state;
  return {
    ...state,
    answer: reviseAnswer(
      {
        ...state.answer,
        selectedOptionIds,
        fieldTexts: { ...state.answer.fieldTexts, [fieldId]: text },
      },
      updatedAt,
    ),
  };
}

export function insertCommittedText(
  state: RequestSession,
  fieldId: string,
  text: string,
  range?: Readonly<{ start: number; end: number }>,
  updatedAt = Date.now(),
): RequestSession {
  const current = state.answer.fieldTexts[fieldId] ?? "";
  const start = unicodeOffset(current, range?.start ?? current.length);
  const end = unicodeOffset(current, range?.end ?? start);
  return replaceFieldText(
    state,
    fieldId,
    current.slice(0, Math.min(start, end)) +
      text +
      current.slice(Math.max(start, end)),
    updatedAt,
  );
}

export function setRequestAuthority(
  state: RequestSession,
  authoritative: boolean,
): RequestSession {
  return state.authoritative === authoritative
    ? state
    : { ...state, authoritative };
}

export function prepareRequestResponse(
  state: RequestSession,
): PreparedRequestResponse {
  const { model, answer } = state;
  if (!state.authoritative || answer.fingerprint !== model.fingerprint)
    return { status: "stale" };
  if (model.request.unsupportedReason)
    return { status: "unsupported", reason: model.request.unsupportedReason };
  if (model.request.kind === "question")
    return prepareQuestionResponse(model, answer);
  const action = model.request.actions.find(
    ({ id }) => id === answer.selectedActionId,
  );
  if (!action) return { status: "incomplete", missing: [model.key.requestId] };
  const updatedPermissions = model.suggestions
    .filter(({ id }) => answer.selectedSuggestionIds.includes(id))
    .map(({ update }) => update);
  return complete(model, answer, {
    behavior: action.behavior,
    selectedActionId: action.id,
    ...(action.behavior === "allow" && updatedPermissions.length
      ? { updatedPermissions }
      : {}),
    ...(action.behavior === "deny" ? { message: "Denied by user" } : {}),
  });
}

export function validateRequestAnswer(
  value: unknown,
  model: NormalizedRequest,
): RequestAnswer {
  const row = record(value);
  const key = record(row?.key);
  const fields = record(row?.fieldTexts);
  if (
    !row ||
    row.schemaVersion !== REQUEST_ANSWER_VERSION ||
    !key ||
    !sameKey(key as RequestKey, model.key) ||
    row.fingerprint !== model.fingerprint ||
    !(
      row.selectedActionId === null || typeof row.selectedActionId === "string"
    ) ||
    !stringArray(row.selectedOptionIds) ||
    !stringArray(row.selectedSuggestionIds) ||
    !fields ||
    Object.values(fields).some((item) => typeof item !== "string") ||
    !nonNegativeInteger(row.revision) ||
    !nonNegativeInteger(row.updatedAt)
  )
    throw new Error("Invalid stored request answer");
  return sanitizeAnswer(
    {
      schemaVersion: REQUEST_ANSWER_VERSION,
      key: { ...model.key },
      fingerprint: model.fingerprint,
      selectedActionId: row.selectedActionId as string | null,
      selectedOptionIds: row.selectedOptionIds,
      selectedSuggestionIds: row.selectedSuggestionIds,
      fieldTexts: fields as Record<string, string>,
      revision: row.revision as number,
      updatedAt: row.updatedAt as number,
    },
    model,
  );
}

function prepareQuestionResponse(
  model: NormalizedRequest,
  answer: RequestAnswer,
): PreparedRequestResponse {
  const answers: Record<string, string> = {};
  const missing: string[] = [];
  model.request.questions.forEach((question, questionIndex) => {
    const fieldId = unitId(model.key.requestId, "question", questionIndex);
    const text = answer.fieldTexts[fieldId]?.trim() ?? "";
    const selected = model.units.filter(
      (unit) =>
        unit.kind === "option" &&
        unit.fieldId === fieldId &&
        answer.selectedOptionIds.includes(unit.id),
    );
    if (text) answers[question.header] = text;
    else if (selected.length)
      answers[question.header] = selected.map(({ label }) => label).join(", ");
    else if (question.allowEmpty) answers[question.header] = "";
    else missing.push(fieldId);
  });
  if (missing.length) return { status: "incomplete", missing };
  if (!model.request.responseSeed)
    return { status: "unsupported", reason: "missing-response-seed" };
  return complete(model, answer, {
    behavior: "allow",
    updatedInput: { ...model.request.responseSeed, answers },
  });
}

function complete(
  model: NormalizedRequest,
  answer: RequestAnswer,
  response: AgentPermissionResponse,
): PreparedRequestResponse {
  return {
    status: "complete",
    requestId: model.key.requestId,
    fingerprint: model.fingerprint,
    answerRevision: answer.revision,
    response,
  };
}

function toggleUnit(
  answer: RequestAnswer,
  model: NormalizedRequest,
  unit: Exclude<RequestUnit, { kind: "text" }>,
): RequestAnswer {
  if (unit.kind === "action")
    return {
      ...answer,
      selectedActionId:
        answer.selectedActionId === unit.actionId && !unit.required
          ? null
          : unit.actionId,
    };
  if (unit.kind === "suggestion")
    return {
      ...answer,
      selectedSuggestionIds: toggled(
        answer.selectedSuggestionIds,
        unit.suggestionId,
      ),
    };
  const selected = answer.selectedOptionIds.includes(unit.id);
  const optional = !unit.required;
  const siblings = new Set(
    model.units
      .filter(
        (candidate) =>
          candidate.kind === "option" && candidate.fieldId === unit.fieldId,
      )
      .map(({ id }) => id),
  );
  const selectedOptionIds = unit.multiple
    ? toggled(answer.selectedOptionIds, unit.id)
    : [
        ...answer.selectedOptionIds.filter((id) => !siblings.has(id)),
        ...(selected && optional ? [] : [unit.id]),
      ];
  const fieldTexts = { ...answer.fieldTexts };
  delete fieldTexts[unit.fieldId];
  return { ...answer, selectedOptionIds, fieldTexts };
}

function sanitizeAnswer(
  answer: RequestAnswer,
  model: NormalizedRequest,
): RequestAnswer {
  const actionIds = new Set(model.request.actions.map(({ id }) => id));
  const optionIds = new Set(
    model.units.filter(({ kind }) => kind === "option").map(({ id }) => id),
  );
  const suggestionIds = new Set(model.suggestions.map(({ id }) => id));
  const fieldIds = new Set(
    model.units
      .filter(({ kind }) => kind === "text")
      .map((unit) => (unit.kind === "text" ? unit.fieldId : "")),
  );
  return {
    ...answer,
    selectedActionId:
      answer.selectedActionId && actionIds.has(answer.selectedActionId)
        ? answer.selectedActionId
        : null,
    selectedOptionIds: unique(answer.selectedOptionIds).filter((id) =>
      optionIds.has(id),
    ),
    selectedSuggestionIds: unique(answer.selectedSuggestionIds).filter((id) =>
      suggestionIds.has(id),
    ),
    fieldTexts: Object.fromEntries(
      Object.entries(answer.fieldTexts).filter(([id]) => fieldIds.has(id)),
    ),
  };
}

function reviseAnswer(answer: RequestAnswer, updatedAt: number): RequestAnswer {
  return { ...answer, revision: answer.revision + 1, updatedAt };
}

function remember(
  state: RequestSession,
  interactionId: number,
): RequestSession {
  return {
    ...state,
    handledInteractionIds: [
      ...state.handledInteractionIds.slice(-63),
      interactionId,
    ],
  };
}

function rememberArea(
  state: RequestAreaSession,
  interactionId: number,
): RequestAreaSession {
  return {
    ...state,
    handledInteractionIds: [
      ...state.handledInteractionIds.slice(-63),
      interactionId,
    ],
  };
}

function requestFingerprint(request: PaseoPermissionRequest): string {
  return hash(
    JSON.stringify({
      provider: request.provider,
      name: request.name,
      kind: request.kind,
      title: request.title,
      description: request.description,
      actions: request.actions,
      questions: request.questions,
      suggestions: request.suggestions,
      responseSeed: request.responseSeed,
      unsupportedReason: request.unsupportedReason,
    }),
  );
}

function unitId(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function sameKey(left: RequestKey, right: RequestKey): boolean {
  return (
    left.serverId === right.serverId &&
    left.agentId === right.agentId &&
    left.requestId === right.requestId
  );
}

function toggled(values: readonly string[], value: string): readonly string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
}

function unicodeOffset(value: string, offset: number): number {
  let result = clamp(offset, 0, value.length);
  if (
    result > 0 &&
    result < value.length &&
    /[\uD800-\uDBFF]/.test(value[result - 1]!) &&
    /[\uDC00-\uDFFF]/.test(value[result]!)
  )
    result--;
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
