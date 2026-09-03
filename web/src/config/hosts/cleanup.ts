export type HostCleanupParticipant = Readonly<{
  name: string;
  cleanup(serverId: string): Promise<void>;
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

  async cleanup(serverId: string): Promise<HostCleanupResult> {
    const settled = await Promise.allSettled(
      this.participants.map((participant) => participant.cleanup(serverId)),
    );
    const result: HostCleanupResult = {
      serverId,
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
