import type { HostCleanupResult } from "./cleanup";

export type HostsConfigNotice = Readonly<{
  revision: number;
  label: string;
  detail: string | null;
  retryServerId: string | null;
}>;

export type HostsConfigState = Readonly<{
  confirmingServerId: string | null;
  removingServerId: string | null;
  notice: HostsConfigNotice | null;
  operationRevision: number;
  cleanup: HostCleanupResult | null;
}>;
