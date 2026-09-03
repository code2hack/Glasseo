import type { SemanticInput } from "../../native/semanticInput";
import {
  createRequestArea,
  prepareRequestResponse,
  reduceRequestAreaInput,
  replaceFieldText,
} from "./model";
import type { RequestAreaSession, RequestReplicaSnapshot } from "./types";

export class StandaloneRequestHarness {
  private state: RequestAreaSession = createRequestArea([]);

  constructor(private readonly root: HTMLElement) {}

  setRequests(requests: RequestAreaSession["requests"]): void {
    this.state = createRequestArea(requests, this.state);
    this.render();
  }

  handleInput(input: SemanticInput): boolean {
    const next = reduceRequestAreaInput(this.state, input);
    const handled = next !== this.state;
    this.state = next;
    if (handled) this.render();
    return handled;
  }

  replaceText(fieldId: string, text: string): void {
    this.state = {
      ...this.state,
      requests: this.state.requests.map((request) =>
        request.model.units.some(
          (unit) => unit.kind === "text" && unit.fieldId === fieldId,
        )
          ? replaceFieldText(request, fieldId, text)
          : request,
      ),
    };
    this.render();
  }

  snapshot(): RequestAreaSession {
    return this.state;
  }

  diagnostics(): Readonly<Record<string, unknown>> {
    return {
      requestCount: this.state.requests.length,
      unitCount: this.state.requests.reduce(
        (count, request) => count + request.model.units.length,
        0,
      ),
      kinds: this.state.requests.map(({ model }) => model.request.kind),
      completeness: this.state.requests.map(
        (request) => prepareRequestResponse(request).status,
      ),
      cursorKind:
        this.state.requests
          .flatMap(({ model }) => model.units)
          .find(({ id }) => id === this.state.cursorUnitId)?.kind ?? null,
      fingerprints: this.state.requests.map(({ model }) => model.fingerprint),
      stale: this.state.requests.some((request) => !request.authoritative),
    };
  }

  private render(): void {
    const fragments: HTMLElement[] = [];
    for (const session of this.state.requests) {
      const heading = document.createElement("section");
      heading.className = "request-heading";
      heading.dataset.kind = session.model.request.kind;
      heading.textContent =
        session.model.request.title ?? session.model.request.name;
      fragments.push(heading);
      for (const unit of session.model.units) {
        const row = document.createElement("div");
        row.className = [
          "request-unit",
          selected(session, unit.id) ? "selected" : "",
          unit.id === this.state.cursorUnitId ? "cursor" : "",
        ]
          .filter(Boolean)
          .join(" ");
        row.dataset.unitKind = unit.kind;
        row.textContent = unit.label;
        fragments.push(row);
      }
      if (session.model.request.unsupportedReason) {
        const status = document.createElement("div");
        status.className = "request-status";
        status.textContent = "Unsupported request";
        fragments.push(status);
      } else if (!session.authoritative) {
        const status = document.createElement("div");
        status.className = "request-status";
        status.textContent = "Offline — response disabled";
        fragments.push(status);
      }
    }
    this.root.replaceChildren(...fragments);
  }
}

export function requestReplicaDiagnostics(
  snapshot: RequestReplicaSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    status: snapshot.status,
    requestCount: snapshot.requests.length,
    unitCount: snapshot.requests.reduce(
      (count, request) => count + request.units.length,
      0,
    ),
    kinds: snapshot.requests.map(({ request }) => request.kind),
    fingerprints: snapshot.requests.map(({ fingerprint }) => fingerprint),
    revision: snapshot.revision,
    stale: !snapshot.authoritative,
    error: snapshot.error,
  };
}

function selected(
  session: RequestAreaSession["requests"][number],
  unitId: string,
): boolean {
  const unit = session.model.units.find(({ id }) => id === unitId);
  if (!unit) return false;
  if (unit.kind === "action")
    return session.answer.selectedActionId === unit.actionId;
  if (unit.kind === "option")
    return session.answer.selectedOptionIds.includes(unit.id);
  if (unit.kind === "suggestion")
    return session.answer.selectedSuggestionIds.includes(unit.suggestionId);
  return session.focusedFieldId === unit.fieldId;
}
