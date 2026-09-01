import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ConnectionOfferSchema } from "@getpaseo/protocol/connection-offer";
import { exportPublicKey, generateKeyPair } from "@getpaseo/relay/e2ee";

export function probePaseoBundleAndCrypto(): boolean {
  const first = generateKeyPair();
  const second = generateKeyPair();
  return (
    typeof DaemonClient === "function" &&
    !ConnectionOfferSchema.safeParse({}).success &&
    first.publicKey.byteLength === 32 &&
    first.secretKey.byteLength === 32 &&
    exportPublicKey(first.publicKey) !== exportPublicKey(second.publicKey)
  );
}
