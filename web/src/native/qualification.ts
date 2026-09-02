export const qualificationLandingActions = [
  "Start testing builtin keys",
  "Start HID binding",
] as const;

export const qualificationSteps = [
  ["Short PRIMARY", "Briefly use the intended PRIMARY control"],
  ["Long PRIMARY", "Hold the intended PRIMARY control"],
  ["Long SECONDARY", "Hold the intended SECONDARY control"],
  ["Double SECONDARY", "Use the intended SECONDARY control twice"],
  ["Short COMMAND", "Briefly use the intended COMMAND control"],
  ["Long COMMAND", "Hold the intended COMMAND control"],
  ["UP", "Perform the intended UP operation"],
  ["DOWN", "Perform the intended DOWN operation"],
  ["LEFT", "Perform the intended LEFT operation"],
  ["RIGHT", "Perform the intended RIGHT operation"],
] as const;

export type QualificationMode = "BUILT_IN" | "HID";

export type QualificationState = {
  view: "landing" | "wizard";
  mode?: QualificationMode;
  sessionId?: string;
  revision?: number;
  stepIndex?: number;
  stepCount?: number;
  stepName?: string;
  stage?: HidQualificationStage;
  phase?: QualificationPhase | HidQualificationPhase;
  attempt?: number;
  operationId?: number | null;
  candidateDisplay?: string | null;
  suppressionResult?: SuppressionResult | null;
  settleDeadlineMillis?: number | null;
  description?: string;
  prompt?: string;
  error?: string | null;
  paused?: boolean;
  complete?: boolean;
};

export type QualificationPhase =
  | "AWAITING_FIRST"
  | "SETTLING_FIRST"
  | "AWAITING_CONFIRMATION"
  | "SETTLING_SECOND"
  | "STEP_CONFIRMED";

export type HidQualificationStage = "BINDING" | "RECOGNITION" | "COMPLETE";
export type HidQualificationPhase =
  | "AWAITING_INPUT"
  | "STEP_CONFIRMED"
  | "COMPLETE";

export type SuppressionResult = "NOT_NEEDED" | "SUCCEEDED" | "FAILED";

export type QualificationSnapshot = Omit<
  QualificationState,
  "view" | "mode"
> & {
  type: "qualification-state";
  sessionId: string;
  mode: QualificationMode;
  revision: number;
  stepIndex: number;
  stepName: string;
  phase: QualificationPhase;
  attempt: number;
  operationId: number | null;
  candidateDisplay: string | null;
  suppressionResult: SuppressionResult | null;
  settleDeadlineMillis: number | null;
  description: string;
  prompt: string;
  error: string | null;
  paused: boolean;
  complete: boolean;
};

export type QualificationAction =
  | {
      type: "native-state";
      snapshot: QualificationSnapshot | HidQualificationSnapshot;
    }
  | { type: "landing" };

export type HidQualificationSnapshot = {
  type: "hid-qualification-state";
  sessionId: string;
  revision: number;
  stage: HidQualificationStage;
  stepIndex: number;
  stepCount: 7 | 10;
  stepName: string;
  phase: HidQualificationPhase;
  prompt: string;
  error: string | null;
  settleDeadlineMillis: null;
  complete: boolean;
};

export function reduceQualification(
  state: QualificationState,
  action: QualificationAction,
): QualificationState {
  if (action.type === "landing") return { view: "landing" };
  const snapshot = action.snapshot;
  if (
    state.sessionId &&
    state.sessionId !== snapshot.sessionId &&
    snapshot.revision !== 1
  )
    return state;
  if (
    state.sessionId === snapshot.sessionId &&
    state.revision !== undefined &&
    snapshot.revision <= state.revision
  )
    return state;
  return {
    view: "wizard",
    ...snapshot,
    mode: snapshot.type === "hid-qualification-state" ? "HID" : snapshot.mode,
  };
}

export function qualificationHeading(
  state: Pick<
    QualificationState,
    "complete" | "stepIndex" | "stepCount" | "stepName"
  >,
): string {
  if (state.complete) return "Qualification complete";
  return state.stepIndex !== undefined && state.stepName
    ? `${state.stepIndex + 1}/${state.stepCount ?? 10} ${state.stepName}`
    : "Input qualification";
}

export type NativeQualificationMessage =
  | { type: "qualification-landing" }
  | QualificationSnapshot
  | HidQualificationSnapshot;

export function decodeQualificationMessage(
  value: unknown,
): NativeQualificationMessage {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid qualification message");
  const message = parsed as Record<string, unknown>;
  if (
    message.type === "hid-qualification-state" &&
    Object.keys(message).length === 12 &&
    typeof message.sessionId === "string" &&
    message.sessionId.length > 0 &&
    Number.isSafeInteger(message.revision) &&
    (message.revision as number) > 0 &&
    isHidStage(message.stage) &&
    Number.isSafeInteger(message.stepIndex) &&
    (message.stepIndex as number) >= 0 &&
    ((message.stage === "BINDING" &&
      message.stepCount === 7 &&
      (message.stepIndex as number) < 7) ||
      (message.stage === "RECOGNITION" &&
        message.stepCount === 10 &&
        (message.stepIndex as number) < 10) ||
      (message.stage === "COMPLETE" &&
        message.stepCount === 10 &&
        message.stepIndex === 10)) &&
    typeof message.stepName === "string" &&
    isHidPhase(message.phase) &&
    typeof message.prompt === "string" &&
    (message.error === null || typeof message.error === "string") &&
    message.settleDeadlineMillis === null &&
    typeof message.complete === "boolean" &&
    message.complete === (message.stage === "COMPLETE")
  ) {
    return message as HidQualificationSnapshot;
  }
  if (
    message.type === "qualification-landing" &&
    Object.keys(message).length === 1
  ) {
    return { type: "qualification-landing" };
  }
  if (
    message.type === "qualification-state" &&
    Object.keys(message).length === 17 &&
    typeof message.sessionId === "string" &&
    message.sessionId.length > 0 &&
    (message.mode === "BUILT_IN" || message.mode === "HID") &&
    Number.isSafeInteger(message.revision) &&
    (message.revision as number) > 0 &&
    Number.isSafeInteger(message.stepIndex) &&
    (message.stepIndex as number) >= 0 &&
    (message.stepIndex as number) < qualificationSteps.length &&
    qualificationSteps[message.stepIndex as number]?.[0] === message.stepName &&
    isPhase(message.phase) &&
    Number.isSafeInteger(message.attempt) &&
    (message.attempt as number) >= 0 &&
    (message.attempt as number) <= 2 &&
    (message.operationId === null ||
      (Number.isSafeInteger(message.operationId) &&
        (message.operationId as number) > 0)) &&
    (message.candidateDisplay === null ||
      typeof message.candidateDisplay === "string") &&
    (message.suppressionResult === null ||
      message.suppressionResult === "NOT_NEEDED" ||
      message.suppressionResult === "SUCCEEDED" ||
      message.suppressionResult === "FAILED") &&
    (message.settleDeadlineMillis === null ||
      Number.isSafeInteger(message.settleDeadlineMillis)) &&
    typeof message.description === "string" &&
    typeof message.prompt === "string" &&
    (message.error === null || typeof message.error === "string") &&
    typeof message.paused === "boolean" &&
    typeof message.complete === "boolean"
  ) {
    return message as NativeQualificationMessage;
  }
  throw new Error("Unknown or malformed qualification message");
}

function isHidStage(value: unknown): value is HidQualificationStage {
  return value === "BINDING" || value === "RECOGNITION" || value === "COMPLETE";
}

function isHidPhase(value: unknown): value is HidQualificationPhase {
  return (
    value === "AWAITING_INPUT" ||
    value === "STEP_CONFIRMED" ||
    value === "COMPLETE"
  );
}

function isPhase(value: unknown): value is QualificationPhase {
  return (
    value === "AWAITING_FIRST" ||
    value === "SETTLING_FIRST" ||
    value === "AWAITING_CONFIRMATION" ||
    value === "SETTLING_SECOND" ||
    value === "STEP_CONFIRMED"
  );
}

export function listenForQualification(
  listener: (message: NativeQualificationMessage) => void,
): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    try {
      listener(decodeQualificationMessage(event.data));
    } catch {
      // Unknown native messages fail closed.
    }
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
