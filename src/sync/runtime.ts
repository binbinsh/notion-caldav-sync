import { StorageLedger, type SyncLedger, type KVLikeStorage } from "./ledger";
import { LiveSyncFacade, type LiveBindings } from "./live";
import { SyncService } from "./service";

export function buildLedger(storage: KVLikeStorage | null | undefined): SyncLedger {
  if (!storage) {
    throw new Error("A KV-compatible storage adapter is required.");
  }
  return new StorageLedger(storage, "ledger:");
}

export function buildService(input: {
  bindings: LiveBindings;
  storage: KVLikeStorage;
  log?: (message: string) => void;
}): SyncService {
  return new SyncService(
    new LiveSyncFacade(input.bindings),
    buildLedger(input.storage),
    input.log,
  );
}
