import {
  normalizeHostPort,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { HostError, type PairingCandidate } from "./types";
import { validatedRelayConnection } from "./relay";

export function parsePairingOffer(scannedValue: string): PairingCandidate {
  const value = scannedValue.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostError("invalid_qr", "Scan an official Paseo pairing QR");
  }
  if (
    url.origin !== "https://app.paseo.sh" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    !url.hash.startsWith("#offer=")
  ) {
    throw new HostError("invalid_qr", "Scan an official Paseo pairing QR");
  }

  try {
    const offer = parseConnectionOfferFromUrl(value);
    if (!offer) throw new Error("Missing offer");
    if (
      !offer.serverId.trim() ||
      offer.serverId !== offer.serverId.trim() ||
      !offer.daemonPublicKeyB64.trim() ||
      offer.daemonPublicKeyB64 !== offer.daemonPublicKeyB64.trim()
    )
      throw new Error("Empty offer field");
    const relayEndpoint = normalizeHostPort(offer.relay.endpoint);
    const useTls =
      offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(relayEndpoint);
    return buildPairingCandidate({
      serverId: offer.serverId,
      relayEndpoint: offer.relay.endpoint,
      useTls,
      daemonPublicKey: offer.daemonPublicKeyB64,
    });
  } catch {
    throw new HostError("invalid_offer", "Paseo pairing offer is invalid");
  }
}

export function buildPairingCandidate(
  fields: Omit<PairingCandidate, "relayUrl">,
): PairingCandidate {
  const relay = validatedRelayConnection(
    fields.relayEndpoint,
    fields.useTls,
    fields.serverId,
  );
  return {
    ...fields,
    relayEndpoint: relay.endpoint,
    relayUrl: relay.url,
  };
}
