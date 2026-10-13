import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { FILE_UID, Manifest, Operation, RecoveryError, StoredObject } from './types';
import { RecoveryStorage, sha256, fingerprintFile } from './storage';

export function stableJSON(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function mediaVersion(file: any) {
  const values = Object.fromEntries(['hash', 'name', 'alternativeText', 'caption', 'focalPoint', 'folderPath', 'mime', 'url', 'ext', 'width', 'height', 'size', 'formats', 'provider', 'provider_metadata'].map((key) => [key, file[key]]));
  return sha256(stableJSON({ ...values, updatedAt: new Date(file.updatedAt).toISOString() }));
}
function relationId(value: any) {
  const id = value && typeof value === 'object' ? value.id : value;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}
export function mediaPermissionSubject(file: any) {
  // Keep file attributes used by conditions, never raw populated admin records.
  // The permission check reloads the creator and current roles when needed.
  const fields = ['id', 'documentId', 'name', 'alternativeText', 'caption', 'focalPoint', 'width', 'height', 'formats',
    'hash', 'ext', 'mime', 'size', 'sizeInBytes', 'url', 'previewUrl', 'provider', 'provider_metadata',
    'folderPath', 'createdAt', 'updatedAt', 'publishedAt'];
  return { ...Object.fromEntries(fields.filter((key) => file[key] !== undefined).map((key) => [key, serializable(file[key])])),
    createdBy: relationId(file.createdBy),
    updatedBy: relationId(file.updatedBy),
    folder: relationId(file.folder) };
}
export async function requestFingerprint(kind: string, targetId: number | undefined, data: any, inputs: any[]) {
  const files = [];
  for (const file of inputs) {
    const content = await fingerprintFile(file.filepath);
    files.push({ name: file.originalFilename, type: file.detectedMimeType || file.mimetype, ...content });
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
  const bodies = new Map<string, string>();
  const image = strapi.plugin('upload').service('image-manipulation');
  const allowed = new Set(Object.keys(strapi.getModel(FILE_UID).attributes));
  try {
    const infos = Array.isArray(data.fileInfo) ? data.fileInfo : [data.fileInfo];
    for (const [index, input] of files.entries()) {
      const declared = input.mimetype && input.mimetype !== 'application/octet-stream' ? input.mimetype : undefined;
      const info = { ...(infos[index] || {}) };
      if (oldFile && info.folder === undefined) info.folder = oldFile.folder?.id ?? oldFile.folder ?? null;
      let file = await original.formatFileInfo({ filename: input.originalFilename ?? 'unamed', type: input.detectedMimeType || declared || 'application/octet-stream', size: input.size }, info, data);
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
        const spool = path.join(directory, `body-${bodies.size}.bin`);
        const hash = createHash('sha256'); let bytes = 0;
        await pipeline(part.file.getStream(), new Transform({ transform(chunk, _encoding, callback) {
          hash.update(chunk); bytes += chunk.length; callback(null, chunk);
        } }), createWriteStream(spool, { flags: 'wx', mode: 0o600 }));
        const checksum = hash.digest('hex');
        const key = storage.key(part.file);
        part.file.url = storage.url(key);
        part.file.provider_metadata = { gthfOperation: operation.key, sha256: checksum };
        const object = { key, sha256: checksum, bytes, mime: part.file.mime };
        manifest.objects.push(object); bodies.set(key, spool);
        if (part.label !== 'original') file.formats[part.label] = serializable(part.file);
      }
      file.provider = strapi.config.get('plugin::upload').provider;
      const values = Object.fromEntries(Object.entries(serializable(file)).filter(([key]) => allowed.has(key)));
      manifest.files.push({ values, ...(oldFile ? { targetId: oldFile.id, previousHash: oldFile.hash, previousVersion: mediaVersion(oldFile), previousUpdatedAt: new Date(oldFile.updatedAt).toISOString(), permissionSubject: mediaPermissionSubject(oldFile) } : {}) });
    }
    return { manifest, bodies, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}
