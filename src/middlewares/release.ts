import type { Core } from '@strapi/strapi';
import type { Context, Next } from 'koa';

export default (config: { timeoutMs?: number } = {}, { strapi }: { strapi: Core.Strapi }) => {
  const timeoutMs = config.timeoutMs ?? 1500;
  // Share a pending check: an unavailable pool cannot accumulate one waiter per probe.
  let pending: Promise<void> | undefined;
  const checkDatabase = () => {
    if (!pending) {
      const query = strapi.db.connection.raw('select 1');
      // Knex cancels a running PostgreSQL query. The outer deadline also covers acquisition.
      const execution = typeof query.timeout === 'function' ? query.timeout(timeoutMs, { cancel: true }) : query;
      const current = Promise.resolve(execution).then(() => undefined);
      pending = current;
      current.finally(() => { if (pending === current) pending = undefined; }).catch(() => {});
    }
    return pending;
  };
  return async (ctx: Context, next: Next) => {
    if (ctx.path !== '/api/release' || ctx.method !== 'GET') return next();
    ctx.set('Cache-Control', 'no-store, max-age=0');
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        checkDatabase(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Database readiness deadline')), timeoutMs); }),
      ]);
      ctx.status = 200;
      ctx.body = { status: 'ok', revision: process.env.GTHF_REVISION || process.env.GTHDF_REVISION || 'development' };
    } catch {
      ctx.status = 503;
      ctx.body = { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  };
};
