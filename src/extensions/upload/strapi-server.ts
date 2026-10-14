import { MediaRecovery, actorFor, operationKey } from '../../infrastructure/recovery/engine';
import { createRecoveryStorage } from '../../infrastructure/recovery/storage';
import { createFaultGate } from '../../infrastructure/recovery/fault-gate';
import { authorizeAdminMediaReceipt, authorizeMediaOperation } from '../../infrastructure/recovery/authorization';
import { batchPermissionOperation } from '../../infrastructure/recovery/batches';
import { createUrlImportController } from '../../infrastructure/recovery/url-import';
import { FILE_UID, Operation, RecoveryError } from '../../infrastructure/recovery/types';

// Private extension contracts are deliberately pinned and checked by tests/build.
const EXPECTED_STRAPI = '5.52.3';
let recovery: MediaRecovery;
let application: any;
// Used only by the isolated PostgreSQL transaction-check process, never an HTTP route.
export async function stopRecoveryForJournalQualification() {
  if (process.env.GTHF_RECOVERY_ISOLATED !== 'true' || process.env.GTHF_RECOVERY_NAMESPACE !== 'gthf-recovery'
    || !process.env.GTHF_RECOVERY_CAMPAIGN || !application || !recovery) {
    throw new Error('Journal qualification requires the isolated campaign process');
  }
  createFaultGate(); // Revalidate marker, namespace and every database override.
  await recovery.stop();
}
async function permissions(ctx: any, operation: Operation) {
  return authorizeAdminMediaReceipt(application, ctx.state.userAbility, operation);
}
export default (plugin: any) => {
  const version = require('@strapi/upload/package.json').version;
  if (version !== EXPECTED_STRAPI) throw new Error(`Media recovery requires reviewed Strapi upload ${EXPECTED_STRAPI}`);
  // A committed replay must not re-run telemetry or paid metadata generation.
  for (const [service, action, replayValue] of [['metrics', 'trackUsage', undefined], ['aiMetadata', 'isEnabled', false]] as const) {
    const factory = plugin.services[service];
    plugin.services[service] = (context: any) => {
      const original = factory(context);
      return { ...original, [action]: function (...args: any[]) {
        if (context.strapi.requestContext.get()?.state?.gthfMediaCommittedReplay) return Promise.resolve(replayValue);
        return original[action].apply(original, args);
      } };
    };
  }
  const createOriginal = plugin.services.upload;
  plugin.services.upload = (context: any) => {
    const original = createOriginal(context);
    return { ...original,
      upload: (request: any, opts?: any) => recovery.upload(original, request, opts),
      replace: (id: number, request: any, opts?: any) => recovery.replace(original, Number(id), request, opts),
      remove: (file: any) => recovery.remove(original, file),
    };
  };
  const bootstrap = plugin.bootstrap;
  plugin.bootstrap = async (context: any) => {
    application = context.strapi;
    if (bootstrap) await bootstrap(context);
    if (context.strapi.config.get('database.connection.client') !== 'postgres') throw new Error('Media recovery requires PostgreSQL');
    recovery = new MediaRecovery(context.strapi, createRecoveryStorage(context.strapi.config.get('plugin::upload')));
    await recovery.start();
  };
  const destroy = plugin.destroy;
  plugin.destroy = async (context: any) => { await recovery?.stop(); if (destroy) await destroy(context); };
  plugin.controllers.recovery = {
    async find(ctx: any) {
      const actor = actorFor(ctx);
      const key = operationKey(ctx.params.key);
      const candidate = await recovery.batches.get(key);
      if (candidate) {
        const batch = await recovery.batches.getOwned(key, actor.id);
        const pm = await permissions(ctx, batchPermissionOperation(batch));
        const receipt = await recovery.batches.receipt(batch);
        if (receipt.result) {
          receipt.result.files = await pm.sanitizeOutput(receipt.result.files, { action: 'plugin::upload.read' });
          receipt.result.folders = await application.service('admin::permission').createPermissionsManager({ ability: ctx.state.userAbility, model: 'plugin::upload.folder' }).sanitizeOutput(receipt.result.folders);
        }
        ctx.set('Cache-Control', 'no-store, max-age=0'); ctx.body = receipt; return;
      }
      const operation = await recovery.journal.getOwned(key, actor.id);
      const pm = await permissions(ctx, operation);
      const receipt = await recovery.receipt(operation.key, actor.id);
      if (receipt.result) receipt.result = await pm.sanitizeOutput(receipt.result, { action: 'plugin::upload.read' });
      ctx.set('Cache-Control', 'no-store, max-age=0');
      ctx.body = receipt;
    },
  };
  plugin.routes.admin.routes.push({ method: 'GET', path: '/recovery/operations/:key', handler: 'recovery.find',
    config: { policies: ['admin::isAuthenticatedAdmin'] } });
  // A successful DELETE replay has no remaining file for Strapi's normal lookup.
  // Recheck the current conditional permission against the saved subject first.
  const destroyFile = plugin.controllers['admin-file'].destroy;
  plugin.controllers['admin-file'].destroy = async function (ctx: any) {
    const header = ctx.get('Idempotency-Key');
    if (header) {
      const key = operationKey(header);
      const previous = await recovery.journal.get(key);
      if (previous) {
        const owned = await recovery.journal.getOwned(key, actorFor(ctx).id);
        if (owned.kind !== 'delete' || owned.target_id !== Number(ctx.params.id)) throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to a different request');
        if (owned.state === 'committed') {
          const pm = await permissions(ctx, owned);
          ctx.set('Idempotency-Key', key);
          ctx.body = await pm.sanitizeOutput(owned.receipt, { action: 'plugin::upload.read' });
          return;
        }
      }
    }
    return destroyFile.call(this, ctx);
  };
  plugin.controllers['admin-upload'].uploadFromUrls = (ctx: any) => createUrlImportController(application, recovery)(ctx);
  plugin.controllers['admin-folder-file'].deleteMany = async (ctx: any) => {
    const result = await recovery.bulkDelete(ctx);
    const pmFile = application.service('admin::permission').createPermissionsManager({ ability: ctx.state.userAbility, action: 'plugin::upload.read', model: FILE_UID });
    const pmFolder = application.service('admin::permission').createPermissionsManager({ ability: ctx.state.userAbility, model: 'plugin::upload.folder' });
    ctx.body = { data: { files: await pmFile.sanitizeOutput(result.files), folders: await pmFolder.sanitizeOutput(result.folders) } };
  };
  const wrap = (controller: any) => {
    for (const [name, action] of Object.entries(controller)) {
      if (typeof action !== 'function') continue;
      controller[name] = async function (ctx: any, ...args: any[]) {
        try { return await action.call(this, ctx, ...args); }
        catch (error) {
          if (!(error instanceof RecoveryError)) throw error;
          ctx.status = error.status;
          ctx.set('Cache-Control', 'no-store, max-age=0');
          ctx.body = { data: null, error: { status: error.status, name: error.code, message: error.message,
            details: { operationKey: ctx.response.get('Idempotency-Key') || undefined } } };
        }
      };
    }
    return controller;
  };
  // Content API routes already enforce their token/role action before invoking
  // the controller. Preserve that action and sanitisation when DELETE is replayed.
  for (const [name, controller] of Object.entries(plugin.controllers)) {
    if (typeof controller !== 'function') { plugin.controllers[name] = wrap(controller); continue; }
    plugin.controllers[name] = (...args: any[]) => {
      const instance = controller(...args);
      if (name === 'content-api') {
        const originalDestroy = instance.destroy;
        instance.destroy = async (ctx: any) => {
          const header = ctx.get('Idempotency-Key');
          if (header) {
            const key = operationKey(header);
            if (await recovery.journal.get(key)) {
              const previous = await recovery.journal.getOwned(key, actorFor(ctx).id);
              if (previous.kind !== 'delete' || previous.target_id !== Number(ctx.params.id)) throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to a different request');
              if (previous.state === 'committed') {
                await authorizeMediaOperation(application, previous);
                ctx.set('Idempotency-Key', key);
                ctx.body = await application.contentAPI.sanitize.output(previous.receipt, application.getModel(FILE_UID), { auth: ctx.state.auth });
                return;
              }
            }
          }
          return originalDestroy(ctx);
        };
      }
      return wrap(instance);
    };
  }
  return plugin;
};
