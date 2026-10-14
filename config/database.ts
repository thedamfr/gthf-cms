import path from 'path';

export default ({ env }) => {
  const client = env('DATABASE_CLIENT', 'postgres');

  const connections = {
    postgres: {
      connection: {
        connectionString: env('POSTGRESQL_ADDON_URI') || env('DATABASE_URL'),
        host: env('POSTGRESQL_ADDON_HOST') || env('DATABASE_HOST', 'localhost'),
        port: env.int('POSTGRESQL_ADDON_PORT') || env.int('DATABASE_PORT', 5432),
        database: env('POSTGRESQL_ADDON_DB') || env('DATABASE_NAME', 'strapi'),
        user: env('POSTGRESQL_ADDON_USER') || env('DATABASE_USERNAME', 'strapi'),
        password: env('POSTGRESQL_ADDON_PASSWORD') || env('DATABASE_PASSWORD', 'strapi'),
        ssl: env.bool('DATABASE_SSL', false) && {
          key: env('DATABASE_SSL_KEY', undefined),
          cert: env('DATABASE_SSL_CERT', undefined),
          ca: env('DATABASE_SSL_CA', undefined),
          capath: env('DATABASE_SSL_CAPATH', undefined),
          cipher: env('DATABASE_SSL_CIPHER', undefined),
          rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
        },
        schema: env('DATABASE_SCHEMA', 'public'),
      },
      pool: { min: env.int('DATABASE_POOL_MIN', 1), max: env.int('DATABASE_POOL_MAX', 3) },
    },
  };

  return {
    // Rolling updates and application rollback must not drop persisted schema.
    settings: {
      forceMigration: env.bool('DATABASE_FORCE_MIGRATION', false),
    },
    connection: {
      client,
      ...connections[client],
      acquireConnectionTimeout: env.int('DATABASE_CONNECTION_TIMEOUT', 60000),
    },
  };
};
