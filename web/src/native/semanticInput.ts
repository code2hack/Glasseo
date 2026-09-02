export const semanticControls = [
  "PRIMARY",
  "SECONDARY",
  "COMMAND",
  "LEFT",
  "RIGHT",
  "UP",
  "DOWN",
] as const;

export const semanticActions = [
  "BEGIN",
  "UPDATE",
  "END",
  "CANCEL",
  "SHORT",
  "LONG",
  "DOUBLE",
] as const;

export type SemanticInput = {
  type: "semantic-input";
  control: (typeof semanticControls)[number];
  action: (typeof semanticActions)[number];
  interactionId: number;
  timeMillis: number;
};

export function decodeSemanticInput(value: unknown): SemanticInput {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid semantic input");
  const message = parsed as Record<string, unknown>;
  if (
    Object.keys(message).length === 5 &&
    message.type === "semantic-input" &&
    semanticControls.includes(message.control as SemanticInput["control"]) &&
    semanticActions.includes(message.action as SemanticInput["action"]) &&
    Number.isSafeInteger(message.interactionId) &&
    (message.interactionId as number) > 0 &&
    Number.isSafeInteger(message.timeMillis) &&
    (message.timeMillis as number) >= 0
  ) {
    return message as SemanticInput;
  }
  throw new Error("Unknown or malformed semantic input");
}

export function listenForSemanticInput(
  listener: (input: SemanticInput) => void,
): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    try {
      listener(decodeSemanticInput(event.data));
    } catch {
      // Unknown native messages fail closed.
    }
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
