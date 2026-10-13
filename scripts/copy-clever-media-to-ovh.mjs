import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const clever = process.env.CLEVER_BIN ?? 'clever';
const cleverApp = process.env.GTHF_CMS_CLEVER_APP ?? process.env.GTHDF_CMS_CLEVER_APP
  ?? 'app_67466113-4135-4892-b3f5-2a8d5a3623f2';
const credentialsFile = process.env.GTHF_OVH_CREDENTIALS_FILE ?? process.env.GTHDF_OVH_CREDENTIALS_FILE;
const destinationBucket = process.env.GTHF_OVH_BUCKET ?? process.env.GTHDF_OVH_BUCKET ?? 'gthdf-staging-media';
const concurrency = Number.parseInt(process.env.GTHF_MEDIA_COPY_CONCURRENCY ?? process.env.GTHDF_MEDIA_COPY_CONCURRENCY ?? '4', 10);

if (!credentialsFile) {
  throw new Error('GTHF_OVH_CREDENTIALS_FILE must point to a private environment file.');
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
  throw new Error('GTHF_MEDIA_COPY_CONCURRENCY must be an integer between 1 and 16.');
}

function environmentMap(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => [entry.name ?? entry.key, entry.value])
        .filter(([name, entryValue]) => name && entryValue !== undefined),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, entryValue]) => [
        name,
        entryValue && typeof entryValue === 'object' && 'value' in entryValue
          ? entryValue.value
          : entryValue,
      ]),
    );
  }
  return {};
}

function parseEnvironmentFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().replace(/^export\s+/, '');
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`Missing or invalid ${name}.`);
  }
  return value;
}

async function listObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (object.Key && Number.isSafeInteger(object.Size)) {
        objects.push({ key: object.Key, size: object.Size });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

const cleverData = JSON.parse(
  execFileSync(clever, ['env', '--app', cleverApp, '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const addonEnvironment = Object.assign(
  {},
  ...(cleverData.fromAddons ?? []).map((addon) => environmentMap(addon.env)),
);
const cleverEnvironment = {
  ...addonEnvironment,
  ...environmentMap(cleverData.env ?? cleverData),
};
const ovhEnvironment = parseEnvironmentFile(credentialsFile);

const sourceBucket = cleverEnvironment.AWS_BUCKET ?? 'gthdf-media';
const sourceEndpoint = `https://${required(cleverEnvironment, 'CELLAR_ADDON_HOST')}`;
const destinationEndpoint = required(ovhEnvironment, 'OVHPAR_S3_ENDPOINT');
const destinationRegion = required(ovhEnvironment, 'OVHPAR_S3_REGION');

const source = new S3Client({
  endpoint: sourceEndpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: required(cleverEnvironment, 'CELLAR_ADDON_KEY_ID'),
    secretAccessKey: required(cleverEnvironment, 'CELLAR_ADDON_KEY_SECRET'),
  },
});
const destination = new S3Client({
  endpoint: destinationEndpoint,
  region: destinationRegion,
  forcePathStyle: true,
  requestStreamBufferSize: 64 * 1024,
  credentials: {
    accessKeyId: required(ovhEnvironment, 'OVH_S3_ACCESSKEY'),
    secretAccessKey: required(ovhEnvironment, 'OVH_S3_SECRETACCESSKEY'),
  },
});

try {
  const sourceObjects = await listObjects(source, sourceBucket);
  const existingObjects = await listObjects(destination, destinationBucket);
  const existingSizes = new Map(existingObjects.map(({ key, size }) => [key, size]));
  let cursor = 0;
  let copied = 0;
  let skipped = 0;

  async function worker() {
    while (cursor < sourceObjects.length) {
      const index = cursor;
      cursor += 1;
      const object = sourceObjects[index];
      if (existingSizes.get(object.key) === object.size) {
        skipped += 1;
        continue;
      }

      const downloaded = await source.send(new GetObjectCommand({
        Bucket: sourceBucket,
        Key: object.key,
      }));
      await destination.send(new PutObjectCommand({
        Bucket: destinationBucket,
        Key: object.key,
        Body: downloaded.Body,
        ContentLength: object.size,
        ContentType: downloaded.ContentType,
        ContentDisposition: downloaded.ContentDisposition,
        ContentEncoding: downloaded.ContentEncoding,
        ContentLanguage: downloaded.ContentLanguage,
        CacheControl: downloaded.CacheControl,
        Metadata: downloaded.Metadata,
        ACL: 'public-read',
      }));
      copied += 1;
      if (copied % 100 === 0) {
        process.stderr.write(`Copied ${copied}/${sourceObjects.length} objects\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const destinationObjects = await listObjects(destination, destinationBucket);
  const destinationSizes = new Map(
    destinationObjects.map(({ key, size }) => [key, size]),
  );
  const missing = sourceObjects.filter(
    ({ key, size }) => destinationSizes.get(key) !== size,
  );
  const sourceBytes = sourceObjects.reduce((total, object) => total + object.size, 0);
  const copiedBytes = sourceObjects.reduce(
    (total, object) => total + (destinationSizes.get(object.key) === object.size ? object.size : 0),
    0,
  );

  const report = {
    sourceObjects: sourceObjects.length,
    sourceBytes,
    copied,
    skipped,
    verifiedObjects: sourceObjects.length - missing.length,
    verifiedBytes: copiedBytes,
    missingOrMismatched: missing.length,
  };
  console.log(JSON.stringify(report, null, 2));
  if (missing.length > 0 || copiedBytes !== sourceBytes) process.exitCode = 1;
} finally {
  source.destroy();
  destination.destroy();
}
