import {
  buildRelayWebSocketUrl,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseHostPort,
} from "@getpaseo/protocol/daemon-endpoints";

export function validatedRelayConnection(
  endpoint: string,
  useTls: boolean,
  serverId: string,
): { endpoint: string; url: string } {
  const parsed = parseHostPort(normalizeHostPort(endpoint));
  const host = parsed.host.toLowerCase();
  const normalized = `${parsed.isIpv6 ? `[${host}]` : host}:${parsed.port}`;
  const url = buildRelayWebSocketUrl({
    endpoint: normalized,
    useTls,
    serverId,
    role: "client",
    version: 2,
  });
  const roundTrip = parseHostPort(extractHostPortFromWebSocketUrl(url));
  if (
    roundTrip.host.toLowerCase() !== host ||
    roundTrip.port !== parsed.port ||
    roundTrip.isIpv6 !== parsed.isIpv6
  )
    throw new Error("Relay endpoint does not round-trip");
  return { endpoint: normalized, url };
}
