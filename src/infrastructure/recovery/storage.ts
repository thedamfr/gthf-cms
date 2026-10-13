import { createHash } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RecoveryError, StoredObject } from './types';

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const REQUEST_MS = 30_000;
export interface RecoveryStorage {
  key(file: { hash: string; ext?: string; path?: string }): string;
  url(key: string): string;
  put(object: StoredObject, bytes: Buffer): Promise<void>;
  exists(object: StoredObject): Promise<boolean>;
  remove(object: StoredObject): Promise<void>;
  close(): void;
}
/** Single PUT, bounded to the configured 10MB file limit: no abandoned multipart session. */
export function createRecoveryStorage(config: any): RecoveryStorage {
  if (config.provider !== 'aws-s3') throw new Error('Media recovery requires the configured aws-s3 provider');
  const options = config.providerOptions;
  const { params, ...clientOptions } = options.s3Options;
  const client = new S3Client({ ...clientOptions, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const bucket = params.Bucket;
  const root = options.rootPath ? `${String(options.rootPath).replace(/\/+$/, '')}/` : '';
  // Match the pinned provider exactly, including historical keys with spaces.
  const safe = (value: string) => value.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  const send = (command: any) => client.send(command, { abortSignal: AbortSignal.timeout(REQUEST_MS) }) as Promise<any>;
  const exists = async (object: StoredObject) => {
    try {
      const head = await send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
      if (object.sha256 && (head.Metadata?.gthfsha256 !== object.sha256 || Number(head.ContentLength) !== object.bytes)) {
        throw new RecoveryError(409, 'OBJECT_CONFLICT', 'Stored media does not match this operation');
      }
      return true;
    } catch (error: any) {
      if (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound' || error.name === 'NoSuchKey') return false;
      throw error;
    }
  };
  return {
    key(file) {
      const folder = safe(file.path || '');
      const prefix = folder ? `${folder}/` : '';
      return `${root}${prefix}${safe(file.hash)}${(file.ext || '').replace(/[^a-zA-Z0-9.]/g, '')}`;
    },
    url(key) {
      if (options.baseUrl) return `${String(options.baseUrl).replace(/\/+$/, '')}/${key}`;
      if (clientOptions.endpoint) return `${String(clientOptions.endpoint).replace(/\/+$/, '')}/${bucket}/${key}`;
      return `https://${bucket}.s3.amazonaws.com/${key}`;
    },
    async put(object, bytes) {
      if (sha256(bytes) !== object.sha256 || bytes.length !== object.bytes) throw new Error('Media bytes changed after preparation');
      try {
        await send(new PutObjectCommand({ Bucket: bucket, Key: object.key, Body: bytes,
          ContentLength: bytes.length, ContentType: object.mime, Metadata: { gthfsha256: object.sha256 },
          IfNoneMatch: '*', ...(!('ACL' in params) ? { ACL: 'public-read' as const } : params.ACL ? { ACL: params.ACL } : {}),
        }));
      } catch (error: any) {
        if (error.$metadata?.httpStatusCode !== 412) throw error;
        // Only the exact same immutable object can satisfy a replay.
      }
      if (!await exists(object)) throw new Error('Media upload was not durable');
    },
    exists,
    async remove(object) {
      if (object.sha256) {
        try { if (!await exists(object)) return; }
        catch (error) {
          // A conflicting object was never owned by this attempt. Its operation
          // is failed; preserve the foreign bytes while cleaning our other keys.
          if (error instanceof RecoveryError && error.code === 'OBJECT_CONFLICT') return;
          throw error;
        }
      }
      await send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
      if (await exists({ key: object.key })) throw new Error('Media cleanup is not yet confirmed');
    },
    close() { client.destroy(); },
  };
}
