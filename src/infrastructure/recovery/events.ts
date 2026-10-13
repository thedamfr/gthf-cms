import { sanitize } from '@strapi/utils';
import type { MediaBatch } from './batches';
import { FILE_UID, OperationKind } from './types';

// Preserve Strapi's informational post-commit effects. They are never replayed
// and are best-effort: a process crash can lose an event, not a durable receipt.
export async function emitCommittedMediaEvent(strapi: any, kind: OperationKind, result: any) {
  for (const media of Array.isArray(result) ? result : [result]) {
    try {
      const output = await sanitize.sanitizers.defaultSanitizeOutput({ schema: strapi.getModel(FILE_UID), getModel: (uid) => strapi.getModel(uid) }, media);
      void Promise.resolve(strapi.eventHub.emit(`media.${kind === 'upload' ? 'create' : kind === 'replace' ? 'update' : 'delete'}`, { media: output })).catch(() => {});
    } catch {}
  }
}
export async function emitCommittedBatchEvents(strapi: any, batch: MediaBatch, result: any) {
  if (result.folders.length) {
    try { void Promise.resolve(strapi.eventHub.emit('media-folder.delete', { folders: result.folders })).catch(() => {}); } catch {}
  }
  const rootAssetNumber = batch.manifest.files.filter(({ file }) => batch.input.fileIds.includes(file.id)).length;
  if (rootAssetNumber + result.folders.length > 1) {
    try {
      await strapi.plugin('upload').service('metrics').trackUsage('didBulkDeleteMediaLibraryElements', {
        eventProperties: { rootFolderNumber: result.folders.length, rootAssetNumber,
          totalFolderNumber: batch.manifest.folders.length, totalAssetNumber: batch.manifest.files.length },
      });
    } catch {}
  }
}
