export const MEDIA_OPERATION_TABLE = 'gthf_media_operations';
export const MEDIA_CLEANUP_TABLE = 'gthf_media_cleanup';
export const LEASE_MS = 90_000;
export const RECONCILE_MS = 15_000;
export const INTERRUPTED_SWEEP_MS = 60_000;
export const FILE_UID = 'plugin::upload.file';
export type OperationKind = 'upload' | 'replace' | 'delete';
export type OperationState = 'preparing' | 'prepared' | 'committed' | 'interrupted' | 'failed';
export type Actor = { id: string; adminUserId?: number };
export type StoredObject = { key: string; sha256?: string; bytes?: number; mime?: string };
export type FilePlan = { values: Record<string, any>; targetId?: number; previousHash?: string; previousVersion?: string; previousUpdatedAt?: string; permissionSubject?: Record<string, any> };
export type Manifest = { files: FilePlan[]; objects: StoredObject[]; obsolete: StoredObject[] };
export type Operation = {
  key: string; actor: string; admin_user_id: number | null; kind: OperationKind;
  request_hash: string; target_version?: string | null; target_id: number | null; attempt: string; state: OperationState;
  manifest: Manifest | null; receipt: any; failure: string | null;
  lease_owner: string | null; lease_until: Date | null; created_at: Date; updated_at: Date;
};
export class RecoveryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'RecoveryError'; }
}
export function publicState(state: OperationState) {
  return state === 'preparing' || state === 'prepared' ? 'pending' : state;
}
export function publicReceipt(operation: Operation) {
  return { key: operation.key, kind: operation.kind, status: publicState(operation.state),
    result: operation.state === 'committed' ? operation.receipt : undefined,
    retryable: operation.state === 'interrupted', error: operation.failure || undefined };
}
