import { FILE_UID, Operation, RecoveryError } from './types';

function revoked(): never {
  throw new RecoveryError(403, 'AUTHORIZATION_REVOKED', 'Media operation permission is no longer available');
}
function validToken(token: any) {
  if (!token || (token.expiresAt && (!Number.isFinite(new Date(token.expiresAt).getTime()) || new Date(token.expiresAt).getTime() <= Date.now()))) revoked();
  return token;
}
/** Same conditional file subject as Strapi's pinned admin upload controllers. */
export async function adminMediaPermissions(strapi: any, ability: any, operation: Operation) {
  const pm = strapi.service('admin::permission').createPermissionsManager({ ability,
    action: operation.kind === 'upload' ? 'plugin::upload.assets.create' : 'plugin::upload.assets.update', model: FILE_UID });
  if (!pm.isAllowed) revoked();
  for (const plan of operation.manifest?.files || []) {
    const subject = plan.permissionSubject || { ...plan.values, createdBy: operation.admin_user_id };
    const creator = subject.createdBy?.id ?? subject.createdBy;
    const author = creator ? await strapi.service('admin::user').findOne(creator, ['roles']) : null;
    if (pm.ability.cannot(pm.action, pm.toSubject({ ...subject, createdBy: author }))) revoked();
  }
  return pm;
}
/** Recheck the durable principal, not a stored credential or an old ability. */
export async function authorizeMediaOperation(strapi: any, operation: Operation) {
  if (operation.actor === 'internal') return; // Trusted in-process jobs have no delegated principal.
  const match = /^(admin|admin-token|api-token|user):(\d+)$/.exec(operation.actor);
  if (!match) revoked();
  const [, kind, id] = match;
  if (kind === 'admin' || kind === 'admin-token') {
    let token: any;
    if (kind === 'admin-token') token = validToken(await strapi.service('admin::api-token-admin').getById(Number(id)));
    const userId = token ? token.adminUserOwner?.id ?? token.adminUserOwner : Number(id);
    const user = userId ? await strapi.service('admin::user').findOne(userId, ['roles']) : null;
    if (!user || user.isActive !== true || user.blocked === true || (token && user.id !== operation.admin_user_id)) revoked();
    const engine = strapi.service('admin::permission').engine;
    await adminMediaPermissions(strapi, await engine.generateUserAbility(user), operation);
    if (token) await adminMediaPermissions(strapi, await engine.generateTokenAbility(token.adminPermissions ?? [], user), operation);
    return;
  }
  const scope = operation.kind === 'delete' ? 'plugin::upload.content-api.destroy' : 'plugin::upload.content-api.upload';
  if (kind === 'api-token') {
    const token = validToken(await strapi.service('admin::api-token-content-api').getById(Number(id)));
    if (token.type === 'full-access') return;
    if (token.type !== 'custom') revoked();
    const ability = await strapi.contentAPI.permissions.engine.generateAbility((token.permissions ?? []).map((action: string) => ({ action })));
    if (!ability.can(scope)) revoked();
    return;
  }
  const plugin = strapi.plugin('users-permissions');
  const user = await plugin.service('user').fetchAuthenticatedUser(Number(id));
  const settings = await strapi.store({ type: 'plugin', name: 'users-permissions' }).get({ key: 'advanced' });
  if (!user || user.blocked || !user.role || (settings?.email_confirmation && !user.confirmed)) revoked();
  const permission = plugin.service('permission');
  const permissions = (await permission.findRolePermissions(user.role.id)).map((value: any) => permission.toContentAPIPermission(value));
  const ability = await strapi.contentAPI.permissions.engine.generateAbility(permissions);
  if (!ability.can(scope)) revoked();
}

/** Receipt access includes the durable principal ceiling even when the request uses an admin token. */
export async function authorizeAdminMediaReceipt(strapi: any, ability: any, operation: Operation) {
  await authorizeMediaOperation(strapi, operation);
  return adminMediaPermissions(strapi, ability, operation);
}
