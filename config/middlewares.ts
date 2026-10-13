function parseMediaOrigins(value: string) {
  return Array.from(new Set(
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => /^https?:\/\/[^/]+$/i.test(origin)),
  ));
}

export default ({ env }) => {
  const mediaOrigins = parseMediaOrigins(env('MEDIA_ALLOWED_ORIGINS', ''));
  const corsOrigins = parseMediaOrigins([
    env('CLIENT_URL', 'http://localhost:3000'),
    env('PREVIEW_ALLOWED_ORIGINS', ''),
  ].join(','));

  return [
    'strapi::logger',
    'strapi::errors',
    {
      name: 'strapi::security',
      config: {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            'connect-src': ["'self'", 'https:'],
            'img-src': [
              "'self'",
              'data:',
              'blob:',
              'https://market-assets.strapi.io',
              'http://127.0.0.1:9000',
              'https://cellar-c2.services.clever-cloud.com',
              ...mediaOrigins,
            ],
            'media-src': [
              "'self'",
              'data:',
              'blob:',
              'http://127.0.0.1:9000',
              'https://cellar-c2.services.clever-cloud.com',
              ...mediaOrigins,
            ],
            upgradeInsecureRequests: null,
          },
        },
      },
    },
    {
      name: 'strapi::cors',
      config: {
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        headers: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'Idempotency-Key'],
        expose: ['Idempotency-Key'],
        keepHeaderOnError: true,
      },
    },
    'global::release',
    'strapi::poweredBy',
    'strapi::query',
    'strapi::body',
    'strapi::session',
    'strapi::favicon',
    'strapi::public',
  ];
};
