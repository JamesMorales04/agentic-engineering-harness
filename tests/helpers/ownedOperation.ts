import { isTerminalOperation, type OperationRecord } from "../../src/operations/state.js";
import { claimControllerEpoch, saveOperation } from "../../src/operations/state.js";

/** Persist a test operation under the deterministic controller owner used by lifecycle APIs. */
export async function saveOwnedOperation(root: string, record: OperationRecord): Promise<void> {
  process.env.AEH_OPERATION_ID = record.id;
  process.env.AEH_CONTROL_ROOT = root;
  process.env.AEH_OPERATION_STATE_REDIRECT = "0";
  await saveOperation(root, record);
  if (!isTerminalOperation(record.status)) await claimControllerEpoch(root, record.id, `controller:test:${record.id}`);
}
