import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const productionOrigin = 'https://gthdf-staging-media.s3.eu-west-par.io.cloud.ovh.net';
const stagingOrigin = 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net';

export function initialExampleTokens(users, tokens) {
  if (users.length) return [];
  return tokens.filter((token) => (token.name === 'Read Only' && token.type === 'read-only')
    || (token.name === 'Full Access' && token.type === 'full-access'));
}

export function isCompletedMediaCopy(head) {
  return head.ContentLength > 0 && /^[a-f0-9]{64}$/.test(head.Metadata?.['gthdf-source-sha256'] ?? '');
}

export function editableColumns(columns) {
  return columns.filter((column) => column.table_type === 'BASE TABLE');
}

export function stagingMediaUrl(value) {
  const url = new URL(value);
  if (![productionOrigin, stagingOrigin].includes(url.origin) || url.username || url.password || url.search || url.hash) throw new Error('Unexpected media origin');
  return stagingOrigin + url.pathname;
}

export function requireStagingTarget(env) {
  const namespace = env.GTHF_NAMESPACE ?? env.GTHDF_NAMESPACE;
  if (!['gthf-qualification', 'gthdf-qualification'].includes(namespace)
    || !['gthf-postgres', 'gthdf-postgres'].includes(env.DATABASE_HOST)
    || env.DATABASE_CLIENT !== 'postgres'
    || env.AWS_BUCKET !== 'gthf-staging-media-bis' || env.AWS_ENDPOINT !== 'https://s3.gra.io.cloud.ovh.net'
    || env.DATABASE_URL || Object.entries(env).some(([key, value]) => /^(POSTGRESQL|CELLAR)_ADDON_/.test(key) && value)) {
    throw new Error('Data preparation is restricted to the isolated qualification database and bucket');
  }
}

export function requireStagingReadToken(token, accessKey) {
  if (token.accessKey !== accessKey || token.type !== 'read-only' || token.kind !== 'content-api'
    || token.lifespan !== null || token.expiresAt !== null) {
    throw new Error('The staging read token has changed');
  }
}

async function prepare() {
  requireStagingTarget(process.env);
  if (!process.env.STAGING_ADMIN_PASSWORD || process.env.STAGING_ADMIN_PASSWORD.length < 24 || !process.env.STRAPI_API_TOKEN) throw new Error('Private staging access is required');
  // Strapi's packaged server uses its CommonJS entry point (as in catalogue.ts).
  const { createStrapi } = createRequire(import.meta.url)('@strapi/strapi');
  const { S3Client, HeadObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const app = createStrapi({ appDir: process.cwd(), distDir: resolve(process.cwd(), 'dist') });
  app.config.set('database.settings.forceMigration', false);
  const client = new S3Client({
    endpoint: process.env.AWS_ENDPOINT, region: 'gra', forcePathStyle: true,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 2,
  });
  let step = 'load isolated CMS';
  try {
    await app.load();
    step = 'copy media';
    const files = await app.db.connection('files').select('url', 'formats', 'mime');
    let copied = 0;
    const unique = new Map();
    for (const file of files) {
      const formats = typeof file.formats === 'string' ? JSON.parse(file.formats) : file.formats;
      for (const item of [file, ...Object.values(formats ?? {})]) {
        if (item.url) unique.set(stagingMediaUrl(item.url), { ...item, mime: item.mime ?? file.mime });
      }
    }
    const entries = [...unique.entries()];
    let cursor = 0;
    let checked = 0;
    async function worker() {
      while (cursor < entries.length) {
        const [destination, item] = entries[cursor++];
        const key = decodeURIComponent(new URL(destination).pathname.slice(1));
        let existing;
        try { existing = await client.send(new HeadObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key })); }
        catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; }
        if (existing && !isCompletedMediaCopy(existing)) throw new Error('An unrecognized staging object already exists');
        if (!existing) {
          const source = productionOrigin + new URL(destination).pathname;
          const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(30000) });
          if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 20 * 1024 * 1024) throw new Error('Source media unavailable or too large');
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 20 * 1024 * 1024) throw new Error('Source media too large');
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          if (!body.byteLength) throw new Error('Empty source media');
          const checksum = createHash('sha256').update(body).digest('hex');
          await client.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key, Body: body, ACL: 'public-read', ContentType: item.mime ?? response.headers.get('content-type') ?? 'application/octet-stream', Metadata: { 'gthdf-source-sha256': checksum } }));
          copied += 1;
        }
        checked += 1;
        if (checked % 250 === 0) console.log(JSON.stringify({ step: 'media', checked, total: entries.length, copied }));
      }
    }
    // Four requests bound memory and avoid exceeding the initial seeding deadline.
    const workers = await Promise.allSettled(Array.from({ length: 4 }, () => worker()));
    if (workers.some((result) => result.status === 'rejected')) throw new Error('Media copy failed');
    step = 'rewrite staging media URLs';
    const columns = await app.db.connection('information_schema.columns as c')
      .join('information_schema.tables as t', function () {
        this.on('c.table_name', '=', 't.table_name').andOn('c.table_schema', '=', 't.table_schema');
      })
      .select('c.table_name', 'c.column_name', 'c.data_type', 't.table_type')
      .where('c.table_schema', 'public').whereIn('c.data_type', ['text', 'character varying', 'json', 'jsonb']);
    await app.db.connection.transaction(async (transaction) => {
      for (const column of editableColumns(columns)) {
        const cast = column.data_type === 'character varying' ? 'text' : column.data_type;
        await transaction.raw(`UPDATE ?? SET ?? = replace(??::text, ?, ?)::${cast} WHERE ??::text LIKE ?`, [column.table_name, column.column_name, column.column_name, productionOrigin, stagingOrigin, column.column_name, '%' + productionOrigin + '%']);
      }
    });
    step = 'provision staging access';
    const email = 'recette@gthf.invalid';
    const users = await app.db.query('admin::user').findMany({});
    if (users.some((user) => user.email !== email)) throw new Error('Unexpected existing administration account');
    const tokens = await app.db.query('admin::api-token').findMany({});
    for (const token of initialExampleTokens(users, tokens)) {
      await app.db.query('admin::api-token').delete({ where: { id: token.id } });
    }
    const roles = await app.db.query('admin::role').findOne({ where: { code: 'strapi-super-admin' } });
    if (!roles) throw new Error('Missing administration role');
    if (users.length === 0) await app.service('admin::user').create({ firstname: 'Recette', lastname: 'GTHF', email, password: process.env.STAGING_ADMIN_PASSWORD, isActive: true, roles: [roles.id] });
    const tokenService = app.service('admin::api-token');
    const name = 'gthdf-staging-read';
    const existing = await app.db.query('admin::api-token').findOne({ where: { name } });
    const accessKey = tokenService.hash(process.env.STRAPI_API_TOKEN);
    if (existing) requireStagingReadToken(existing, accessKey);
    if (!existing) await app.db.query('admin::api-token').create({ data: { name, kind: 'content-api', type: 'read-only', accessKey, lifespan: null, expiresAt: null } });
    console.log(JSON.stringify({ status: 'prepared', mediaObjects: entries.length, copied, productionWrites: 0 }));
  } catch {
    throw new Error('Staging data preparation failed during: ' + step);
  } finally {
    client.destroy();
    await app.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepare().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
