import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import middlewares from '../config/middlewares.ts';
import plugins from '../config/plugins.ts';

function createEnv(values: Record<string, string>) {
  const env = (name: string, fallback?: string) => values[name] ?? fallback;
  return env;
}

test('configures an external S3-compatible bucket without Clever Cellar', () => {
  const config = plugins({
    env: createEnv({
      NODE_ENV: 'production',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_REGION: 'eu-west-par',
      AWS_ENDPOINT: 'https://s3.eu-west-par.io.cloud.ovh.net',
      AWS_BUCKET: 'gthdf-staging-media',
      AWS_CDN_URL: 'https://media-staging.gthf.fr',
    }),
  });

  const options = config.upload.config.providerOptions;
  assert.equal(options.baseUrl, 'https://media-staging.gthf.fr');
  assert.equal(options.s3Options.endpoint, 'https://s3.eu-west-par.io.cloud.ovh.net');
  assert.equal(options.s3Options.region, 'eu-west-par');
  assert.equal(options.s3Options.params.Bucket, 'gthdf-staging-media');
  assert.equal(options.s3Options.credentials.accessKeyId, 'test-access-key');
});

test('adds reviewed HTTPS media origins to the Strapi CSP', () => {
  const configured = middlewares({
    env: createEnv({
      MEDIA_ALLOWED_ORIGINS:
        'https://media-staging.gthf.fr, https://s3.eu-west-par.io.cloud.ovh.net',
    }),
  });
  const security = configured.find(
    (entry) => typeof entry === 'object' && entry.name === 'strapi::security',
  );

  assert.ok(security && typeof security === 'object');
  const directives = security.config.contentSecurityPolicy.directives;
  assert.ok(directives['img-src'].includes('https://media-staging.gthf.fr'));
  assert.ok(directives['media-src'].includes('https://media-staging.gthf.fr'));
  assert.ok(directives['img-src'].includes('https://s3.eu-west-par.io.cloud.ovh.net'));
});

test('restricts CORS to the configured frontend and preview origins', () => {
  const configured = middlewares({
    env: createEnv({
      CLIENT_URL: 'https://staging.gthf.fr',
      PREVIEW_ALLOWED_ORIGINS:
        'https://staging.gthf.fr, https://preview.gthf.fr, invalid-origin',
    }),
  });
  const cors = configured.find(
    (entry) => typeof entry === 'object' && entry.name === 'strapi::cors',
  );

  assert.ok(cors && typeof cors === 'object');
  assert.deepEqual(cors.config.origin, [
    'https://staging.gthf.fr',
    'https://preview.gthf.fr',
  ]);
  assert.equal(cors.config.credentials, true);
  assert.doesNotMatch(JSON.stringify(cors.config), /\*/);
});

test('the Strapi runtime image is non-root and does not embed secrets', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^LABEL io\.gthf\.media-recovery="1"$/m);
  assert.match(dockerfile, /strapi\.js", "start/);
  assert.doesNotMatch(dockerfile, /(APP_KEYS|ADMIN_JWT_SECRET|AWS_SECRET_ACCESS_KEY)=/);
});

test('the media migration is resumable and never deletes Clever objects', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  const migration = readFileSync(
    new URL('../scripts/copy-clever-media-to-ovh.mjs', import.meta.url),
    'utf8',
  );

  assert.equal(
    packageJson.scripts['migrate:media:ovh-staging'],
    'node scripts/copy-clever-media-to-ovh.mjs',
  );
  assert.match(migration, /ListObjectsV2Command/);
  assert.match(migration, /GetObjectCommand/);
  assert.match(migration, /PutObjectCommand/);
  assert.match(migration, /public-read/);
  assert.match(migration, /requestStreamBufferSize: 64 \* 1024/);
  assert.match(migration, /GTHDF_OVH_CREDENTIALS_FILE/);
  assert.doesNotMatch(migration, /DeleteObjectCommand/);
  assert.doesNotMatch(migration, /salete-sincere-podcast-studio/);
});
