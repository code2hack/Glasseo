import { sameAgentKey } from "../directory/normalize";
import type { AgentKey } from "../directory/types";
import {
  DRAFT_SCHEMA_VERSION,
  type DraftAction,
  type DraftArea,
  type DraftImageRef,
  type DraftRecord,
  type DraftSessionState,
  type DraftTransition,
  type DraftTransientState,
} from "./types";

const AREA_ORDER: readonly DraftArea[] = ["request", "text", "images"];

export function createDraftRecord(
  key: AgentKey,
  updatedAt = Date.now(),
): DraftRecord {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    key: { ...key },
    revision: 0,
    updatedAt,
    text: "",
    images: [],
    activeArea: "text",
    cursors: { requestId: null, textOffset: 0, imageId: null },
  };
}

export function defaultDraftTransientState(): DraftTransientState {
  return {
    mode: "edit",
    textSelection: null,
    selectedImageIds: [],
    provisionalText: null,
    wheelOpen: false,
    pending: false,
  };
}

export function createDraftSession(
  record: DraftRecord,
  requestIds: readonly string[],
): DraftSessionState {
  return reconcileSession({
    record,
    requestIds: uniqueIds(requestIds),
    transient: defaultDraftTransientState(),
    handledInteractionIds: [],
  });
}

export function availableDraftAreas(
  state: Pick<DraftSessionState, "record" | "requestIds">,
): readonly DraftArea[] {
  return AREA_ORDER.filter(
    (area) =>
      area === "text" ||
      (area === "request" && state.requestIds.length > 0) ||
      (area === "images" && state.record.images.length > 0),
  );
}

export function reduceDraft(
  state: DraftSessionState,
  action: DraftAction,
): DraftTransition {
  if (action.type === "cycle-area" || action.type === "move-within-area") {
    const record =
      action.type === "cycle-area"
        ? cycle(
            state.record,
            availableDraftAreas(state),
            action.direction === "left" ? "LEFT" : "RIGHT",
          )
        : move(
            state.record,
            state.requestIds,
            action.direction === "up" ? "UP" : "DOWN",
          );
    const next =
      record === state.record ? state : { ...state, record: revise(record) };
    return transition(state, next, true);
  }
  if (action.type === "set-requests") {
    const next = reconcileSession({
      ...state,
      requestIds: uniqueIds(action.requestIds),
    });
    return transition(state, next, true);
  }
  if (action.type === "set-images") {
    const next = reconcileSession({
      ...state,
      record: { ...state.record, images: uniqueImages(action.images) },
    });
    return transition(state, next, true);
  }
  if (
    action.action !== "SHORT" ||
    !["LEFT", "RIGHT", "UP", "DOWN"].includes(action.control)
  )
    return { state, effect: "none", handled: false };
  if (state.handledInteractionIds.includes(action.interactionId))
    return { state, effect: "none", handled: true };

  let record = state.record;
  if (action.control === "LEFT" || action.control === "RIGHT")
    record = cycle(record, availableDraftAreas(state), action.control);
  else if (action.control === "UP" || action.control === "DOWN")
    record = move(record, state.requestIds, action.control);
  const changed = record !== state.record;
  const next = {
    ...state,
    record: changed ? revise(record) : record,
    handledInteractionIds: [
      // ponytail: 64 IDs cover native replay; persist a ledger only if replay spans sessions.
      ...state.handledInteractionIds.slice(-63),
      action.interactionId,
    ],
  };
  return { state: next, effect: changed ? "persist" : "none", handled: true };
}

export function validateDraftRecord(
  value: unknown,
  expectedKey: AgentKey,
): DraftRecord {
  if (!record(value) || Object.keys(value).length !== 8) throw invalid();
  const key = record(value.key)
    ? { serverId: value.key.serverId, agentId: value.key.agentId }
    : null;
  if (
    value.schemaVersion !== DRAFT_SCHEMA_VERSION ||
    !key ||
    !text(key.serverId) ||
    !text(key.agentId) ||
    !sameAgentKey(key as AgentKey, expectedKey) ||
    !integer(value.revision) ||
    !integer(value.updatedAt) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.images) ||
    !["request", "text", "images"].includes(String(value.activeArea)) ||
    !record(value.cursors)
  )
    throw invalid();
  const cursors = value.cursors;
  if (
    Object.keys(cursors).length !== 3 ||
    !(cursors.requestId === null || text(cursors.requestId)) ||
    !Number.isSafeInteger(cursors.textOffset) ||
    !(cursors.imageId === null || text(cursors.imageId))
  )
    throw invalid();
  const images = uniqueImages(value.images.map(validateImage));
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    key: { ...expectedKey },
    revision: value.revision,
    updatedAt: value.updatedAt,
    text: value.text,
    images,
    activeArea: value.activeArea as DraftArea,
    cursors: {
      requestId: cursors.requestId,
      textOffset: validTextOffset(value.text, cursors.textOffset as number),
      imageId: cursors.imageId,
    },
  };
}

function sameReconciledFields(a: DraftRecord, b: DraftRecord): boolean {
  return (
    a.activeArea === b.activeArea &&
    a.cursors.requestId === b.cursors.requestId &&
    a.cursors.textOffset === b.cursors.textOffset &&
    a.cursors.imageId === b.cursors.imageId &&
    a.images === b.images
  );
}

function reconcileSession(state: DraftSessionState): DraftSessionState {
  const areas = availableDraftAreas(state);
  const requestId = state.requestIds.includes(
    state.record.cursors.requestId ?? "",
  )
    ? state.record.cursors.requestId
    : (state.requestIds[0] ?? null);
  const imageId = state.record.images.some(
    ({ id }) => id === state.record.cursors.imageId,
  )
    ? state.record.cursors.imageId
    : (state.record.images[0]?.id ?? null);
  const activeArea = areas.includes(state.record.activeArea)
    ? state.record.activeArea
    : "text";
  const record = {
    ...state.record,
    activeArea,
    cursors: {
      requestId,
      textOffset: validTextOffset(
        state.record.text,
        state.record.cursors.textOffset,
      ),
      imageId,
    },
  };
  return sameReconciledFields(state.record, record)
    ? state
    : { ...state, record: revise(record) };
}

function cycle(
  record: DraftRecord,
  areas: readonly DraftArea[],
  direction: "LEFT" | "RIGHT",
): DraftRecord {
  if (areas.length < 2) return record;
  const current = areas.indexOf(record.activeArea);
  const offset = direction === "LEFT" ? -1 : 1;
  const activeArea = areas[(current + offset + areas.length) % areas.length]!;
  return activeArea === record.activeArea ? record : { ...record, activeArea };
}

function move(
  record: DraftRecord,
  requestIds: readonly string[],
  direction: "UP" | "DOWN",
): DraftRecord {
  if (record.activeArea === "text") return record;
  const ids =
    record.activeArea === "request"
      ? requestIds
      : record.images.map(({ id }) => id);
  if (ids.length === 0) return record;
  const field = record.activeArea === "request" ? "requestId" : "imageId";
  const current = Math.max(0, ids.indexOf(record.cursors[field] ?? ""));
  const next = Math.max(
    0,
    Math.min(ids.length - 1, current + (direction === "UP" ? -1 : 1)),
  );
  if (next === current && record.cursors[field] === ids[current]) return record;
  return { ...record, cursors: { ...record.cursors, [field]: ids[next] } };
}

function transition(
  previous: DraftSessionState,
  next: DraftSessionState,
  handled: boolean,
): DraftTransition {
  return {
    state: next,
    effect: previous.record === next.record ? "none" : "persist",
    handled,
  };
}

function revise(record: DraftRecord): DraftRecord {
  return { ...record, revision: record.revision + 1 };
}

function validTextOffset(value: string, offset: number): number {
  let result = Math.max(0, Math.min(value.length, offset));
  if (
    result > 0 &&
    result < value.length &&
    /[\uD800-\uDBFF]/.test(value[result - 1]!) &&
    /[\uDC00-\uDFFF]/.test(value[result]!)
  )
    result--;
  return result;
}

function validateImage(value: unknown): DraftImageRef {
  if (!record(value)) throw invalid();
  const allowed = new Set([
    "id",
    "token",
    "mimeType",
    "capturedAt",
    "width",
    "height",
    "bytes",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !text(value.id) ||
    !text(value.token) ||
    !/^image\/[a-z0-9.+-]+$/i.test(String(value.mimeType)) ||
    !integer(value.capturedAt) ||
    !optionalPositiveInteger(value.width) ||
    !optionalPositiveInteger(value.height) ||
    !optionalPositiveInteger(value.bytes)
  )
    throw invalid();
  return value as DraftImageRef;
}

function uniqueImages(
  values: readonly DraftImageRef[],
): readonly DraftImageRef[] {
  const ids = new Set<string>();
  return values.map((value) => {
    const image = validateImage(value);
    if (ids.has(image.id)) throw invalid();
    ids.add(image.id);
    return image;
  });
}

function uniqueIds(values: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (!text(value) || ids.has(value)) throw invalid();
    ids.add(value);
  }
  return [...ids];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (integer(value) && (value as number) > 0);
}

function invalid(): Error {
  return new Error("Stored Draft is invalid");
}
