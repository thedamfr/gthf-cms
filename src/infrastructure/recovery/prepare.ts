import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILE_UID, Manifest, Operation, RecoveryError, StoredObject } from './types';
import { RecoveryStorage, sha256 } from './storage';

export function stableJSON(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function requestFingerprint(kind: string, targetId: number | undefined, data: any, inputs: any[]) {
  const files = [];
  for (const file of inputs) {
    const content = await fs.readFile(file.filepath);
    files.push({ name: file.originalFilename, type: file.detectedMimeType || file.mimetype, bytes: content.length, sha256: sha256(content) });
  }
  return sha256(stableJSON({ kind, targetId, data, files }));
}
function serializable(value: any): any {
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !['filepath', 'tmpWorkingDirectory', 'buffer', 'stream', 'getStream'].includes(key) && typeof entry !== 'function')
    .map(([key, entry]) => [key, serializable(entry)]));
  return value;
}
export function existingObjects(file: any, storage: RecoveryStorage, provider: string): StoredObject[] {
  if (file.provider !== provider) return [];
  return [file, ...Object.values(file.formats || {})].map((part: any) => ({ key: storage.key(part) }));
}
export async function prepareMedia(strapi: any, original: any, storage: RecoveryStorage, operation: Operation, data: any, files: any[], oldFile?: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-media-'));
  const manifest: Manifest = { files: [], objects: [], obsolete: oldFile ? existingObjects(oldFile, storage, strapi.config.get('plugin::upload').provider) : [] };
  const bodies = new Map<string, Buffer>();
  const image = strapi.plugin('upload').service('image-manipulation');
  const allowed = new Set(Object.keys(strapi.getModel(FILE_UID).attributes));
  try {
    const infos = Array.isArray(data.fileInfo) ? data.fileInfo : [data.fileInfo];
    for (const [index, input] of files.entries()) {
      const declared = input.mimetype && input.mimetype !== 'application/octet-stream' ? input.mimetype : undefined;
      let file = await original.formatFileInfo({ filename: input.originalFilename ?? 'unamed', type: input.detectedMimeType || declared || 'application/octet-stream', size: input.size }, infos[index] || {}, data);
      file.hash = `gthf_${operation.attempt.replace(/-/g, '')}_${index}`;
      file.path = undefined; // The journal owns these keys; never trust a caller-provided object path.
      file.tmpWorkingDirectory = directory;
      file.filepath = input.filepath;
      file.getStream = () => createReadStream(input.filepath);
      if (await image.isImage(file)) {
        if (await image.isFaultyImage(file)) throw new RecoveryError(400, 'INVALID_MEDIA', 'The image is invalid');
        if (await image.isOptimizableImage(file)) file = await image.optimize(file);
      }
      await strapi.plugin('upload').service('provider').checkFileSize(file);
      const parts: { label: string; file: any }[] = [{ label: 'original', file }];
      if (await image.isImage(file)) {
        Object.assign(file, await image.getDimensions(file));
        if (await image.isResizableImage(file)) {
          const thumbnail = await image.generateThumbnail(file);
          if (thumbnail) parts.push({ label: 'thumbnail', file: thumbnail });
          for (const format of await image.generateResponsiveFormats(file) || []) if (format) parts.push({ label: format.key, file: format.file });
        }
      }
      file.formats = {};
      for (const part of parts) {
        part.file.hash = `gthf_${operation.attempt.replace(/-/g, '')}_${index}_${part.label}`;
        part.file.path = undefined;
        const chunks = [];
        for await (const chunk of part.file.getStream()) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const key = storage.key(part.file);
        part.file.url = storage.url(key);
        part.file.provider_metadata = { gthfOperation: operation.key, sha256: sha256(bytes) };
        const object = { key, sha256: sha256(bytes), bytes: bytes.length, mime: part.file.mime };
        manifest.objects.push(object); bodies.set(key, bytes);
        if (part.label !== 'original') file.formats[part.label] = serializable(part.file);
      }
      file.provider = strapi.config.get('plugin::upload').provider;
      const values = Object.fromEntries(Object.entries(serializable(file)).filter(([key]) => allowed.has(key)));
      manifest.files.push({ values, ...(oldFile ? { targetId: oldFile.id, previousHash: oldFile.hash, previousUpdatedAt: new Date(oldFile.updatedAt).toISOString(), permissionSubject: serializable(oldFile) } : {}) });
    }
    return { manifest, bodies };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
