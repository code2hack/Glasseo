export type HostCleanupParticipant = Readonly<{
  name: string;
  cleanup(operation: HostCleanupOperation): Promise<void>;
}>;

export type HostCleanupOperation = Readonly<{
  serverId: string;
  token: number;
  assertActive(): void;
}>;

export type HostCleanupResult = Readonly<{
  serverId: string;
  completed: readonly string[];
  failed: readonly string[];
}>;

export class HostCleanupError extends Error {
  constructor(public readonly result: HostCleanupResult) {
    super(`Host cleanup failed: ${result.failed.join(", ")}`);
    this.name = "HostCleanupError";
  }
}

export class HostCleanupCoordinator {
  constructor(
    private readonly participants: readonly HostCleanupParticipant[],
  ) {}

  async cleanup(operation: HostCleanupOperation): Promise<HostCleanupResult> {
    const settled = await Promise.allSettled(
      this.participants.map(async (participant) => {
        operation.assertActive();
        await participant.cleanup(operation);
        operation.assertActive();
      }),
    );
    const result: HostCleanupResult = {
      serverId: operation.serverId,
      completed: this.participants
        .filter((_, index) => settled[index]?.status === "fulfilled")
        .map(({ name }) => name),
      failed: this.participants
        .filter((_, index) => settled[index]?.status === "rejected")
        .map(({ name }) => name),
    };
    if (result.failed.length) throw new HostCleanupError(result);
    return result;
  }
}

export function emptyHostCleanupParticipant(
  name: "native-media" | "request-answers",
): HostCleanupParticipant {
  return { name, cleanup: async () => {} };
}
