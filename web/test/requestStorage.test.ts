import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { normalizePermissionRequest } from "../src/paseo/adapter";
import {
  createRequestSession,
  projectRequest,
  reduceRequestInput,
} from "../src/draft/request/model";
import {
  RequestAnswerController,
  requestAnswerKey,
} from "../src/draft/request/storage";
import type {
  NormalizedRequest,
  RequestAnswer,
  RequestAnswerStorage,
  RequestKey,
} from "../src/draft/request/types";

test("answer persistence is collision-safe, minimal, and isolated by host and Agent", async () => {
  const storage = new MemoryStorage();
  const controller = new RequestAnswerController(storage);
  const alpha = model("host-a", "agent", "same");
  const beta = model("host-b", "agent", "same");
  const sibling = model("host-a", "sibling", "same");
  for (const item of [alpha, beta, sibling]) {
    let state = await controller.hydrate(item);
    state = chooseAccept(state);
    assert.equal(await controller.persist(state), true);
  }
  assert.equal(storage.rows.size, 3);
  assert.equal(
    requestAnswerKey(alpha.key) === requestAnswerKey(beta.key),
    false,
  );
  for (const record of storage.rows.values()) {
    assert.deepEqual(Object.keys(record as object).sort(), [
      "fieldTexts",
      "fingerprint",
      "key",
      "revision",
      "schemaVersion",
      "selectedActionId",
      "selectedOptionIds",
      "selectedSuggestionIds",
      "updatedAt",
    ]);
    assert.equal(JSON.stringify(record).includes("private payload"), false);
  }
  await controller.discardHost("host-a");
  assert.deepEqual(
    [...storage.rows.values()].map(
      (record) => (record as RequestAnswer).key.serverId,
    ),
    ["host-b"],
  );
});

test("restart restores only a matching fingerprint and corrupt siblings stay isolated", async () => {
  const storage = new MemoryStorage();
  const original = model("host", "agent", "request");
  const first = new RequestAnswerController(storage);
  const state = chooseAccept(await first.hydrate(original));
  await first.persist(state);
  storage.rows.set(
    requestAnswerKey({ ...original.key, requestId: "corrupt" }),
    {
      nope: true,
    },
  );

  const restarted = new RequestAnswerController(storage);
  assert.equal(
    (await restarted.hydrate(original)).answer.selectedActionId,
    "accept",
  );
  const replacement = model("host", "agent", "request", "changed");
  assert.equal(
    (await restarted.hydrate(replacement)).answer.selectedActionId,
    null,
  );
  assert.equal(
    (await restarted.hydrate(model("host", "agent", "corrupt"))).answer
      .revision,
    0,
  );
});

test("late hydration and stale writes cannot resurrect a discarded or replaced request", async () => {
  const storage = new DeferredStorage();
  const controller = new RequestAnswerController(storage);
  const original = model("host", "agent", "request");
  const replacement = model("host", "agent", "request", "replacement");
  const pending = controller.hydrate(original);
  const replacementPending = controller.hydrate(replacement);
  storage.resolveLoads();
  assert.equal((await pending).authoritative, false);
  const current = await replacementPending;
  const stale = chooseAccept(createRequestSession(original));
  await controller.discard(original.key);
  assert.equal(await controller.persist(stale), false);
  assert.equal(await controller.persist(current), false);
  assert.equal(storage.rows.size, 0);
});

function model(
  serverId: string,
  agentId: string,
  requestId: string,
  title = "private payload",
): NormalizedRequest {
  const raw: AgentPermissionRequest = {
    id: requestId,
    provider: "codex",
    name: "CodexBash",
    kind: "tool",
    title,
  };
  return projectRequest(serverId, agentId, normalizePermissionRequest(raw));
}

function chooseAccept(state: ReturnType<typeof createRequestSession>) {
  return reduceRequestInput(
    { ...state, cursor: 1 },
    {
      type: "semantic-input",
      control: "PRIMARY",
      action: "SHORT",
      interactionId: 1,
      timeMillis: 1,
    },
    1,
  );
}

class MemoryStorage implements RequestAnswerStorage {
  readonly rows = new Map<string, unknown>();
  async load(key: RequestKey): Promise<unknown | null> {
    return this.rows.get(requestAnswerKey(key)) ?? null;
  }
  async put(answer: RequestAnswer): Promise<boolean> {
    this.rows.set(requestAnswerKey(answer.key), answer);
    return true;
  }
  async delete(key: RequestKey): Promise<void> {
    this.rows.delete(requestAnswerKey(key));
  }
  async deleteHost(serverId: string): Promise<void> {
    for (const [id, raw] of this.rows) {
      const answer = raw as Partial<RequestAnswer>;
      if (answer.key?.serverId === serverId) this.rows.delete(id);
    }
  }
}

class DeferredStorage extends MemoryStorage {
  private readonly loads: Array<(value: unknown | null) => void> = [];
  override load(key: RequestKey): Promise<unknown | null> {
    return new Promise((resolve) =>
      this.loads.push((value) =>
        resolve(value ?? this.rows.get(requestAnswerKey(key)) ?? null),
      ),
    );
  }
  resolveLoads(): void {
    this.loads.splice(0).forEach((resolve) => resolve(null));
  }
}
