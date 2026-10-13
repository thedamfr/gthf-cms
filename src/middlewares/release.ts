import type { Core } from '@strapi/strapi';
import type { Context, Next } from 'koa';

export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  return async (ctx: Context, next: Next) => {
    if (ctx.path !== '/api/release' || ctx.method !== 'GET') return next();
    ctx.set('Cache-Control', 'no-store, max-age=0');
    try {
      await strapi.db.connection.raw('select 1');
      ctx.status = 200;
      ctx.body = { status: 'ok', revision: process.env.GTHF_REVISION || process.env.GTHDF_REVISION || 'development' };
    } catch {
      ctx.status = 503;
      ctx.body = { status: 'unavailable' };
    }
  };
};
