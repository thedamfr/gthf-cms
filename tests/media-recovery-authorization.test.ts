import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeMediaOperation } from '../src/infrastructure/recovery/authorization';
import { MediaRecovery, actorFor } from '../src/infrastructure/recovery/engine';
import { RecoveryError } from '../src/infrastructure/recovery/types';

const operation = (actor = 'admin:4', kind = 'upload') => ({ actor, admin_user_id: 4, kind,
  manifest: { files: [{ values: { name: 'fixture' } }], objects: [], obsolete: [] } }) as any;
const denied = (error: any) => error.status === 403 && error.code === 'AUTHORIZATION_REVOKED';
function adminFixture() {
  const state = { active: true, userAllowed: true, tokenAllowed: true, authorRole: 'author', condition: false,
    token: { kind: 'admin', adminUserOwner: { id: 4 }, adminPermissions: [], expiresAt: null } as any };
  const permission = {
    engine: { generateUserAbility: async () => ({ allowed: state.userAllowed }), generateTokenAbility: async () => ({ allowed: state.tokenAllowed }) },
    createPermissionsManager: ({ ability, action }) => ({ action, isAllowed: ability.allowed, ability: {
      cannot: (_action, subject) => state.condition && subject.createdBy?.roles?.[0]?.code !== 'author',
    }, toSubject: (subject) => subject }),
  };
  const strapi = { service: (name: string) => name === 'admin::permission' ? permission
    : name === 'admin::api-token-admin' ? { getById: async () => state.token }
    : { findOne: async (id) => ({ id, isActive: state.active, roles: [{ code: state.authorRole }] }) } };
  return { state, strapi };
}
test('pending admin work rechecks changed rights, disabled actors and current creator conditions', async () => {
  const { state, strapi } = adminFixture();
  await authorizeMediaOperation(strapi, operation());
  state.userAllowed = false; await assert.rejects(authorizeMediaOperation(strapi, operation()), denied);
  state.userAllowed = true; state.active = false; await assert.rejects(authorizeMediaOperation(strapi, operation()), denied);
  state.active = true; state.condition = true;
  const replacement = operation('admin:4', 'replace'); replacement.manifest.files[0].permissionSubject = { id: 12, createdBy: 7 };
  await authorizeMediaOperation(strapi, replacement);
  state.authorRole = 'revoked'; await assert.rejects(authorizeMediaOperation(strapi, replacement), denied);
});
test('admin-token recovery requires the current owner ceiling and token permissions', async () => {
  const { state, strapi } = adminFixture();
  await authorizeMediaOperation(strapi, operation('admin-token:9'));
  state.tokenAllowed = false; await assert.rejects(authorizeMediaOperation(strapi, operation('admin-token:9')), denied);
  state.tokenAllowed = true; state.userAllowed = false; await assert.rejects(authorizeMediaOperation(strapi, operation('admin-token:9')), denied);
  state.userAllowed = true; state.token = null; await assert.rejects(authorizeMediaOperation(strapi, operation('admin-token:9')), denied);
});
test('content API tokens preserve their identity and cannot recover after expiry or scope removal', async () => {
  assert.deepEqual(actorFor({ state: { auth: { strategy: { name: 'content-api-token' }, credentials: { id: 9 } } } }), { id: 'api-token:9' });
  assert.deepEqual(actorFor({ state: { auth: { strategy: { name: 'admin-token' }, credentials: { id: 9 } }, userAbility: {}, user: { id: 4 } } }), { id: 'admin-token:9', adminUserId: 4 });
  let token: any = { type: 'custom', permissions: ['plugin::upload.content-api.upload'], expiresAt: null };
  const strapi = { service: () => ({ getById: async () => token }), contentAPI: { permissions: { engine: {
    generateAbility: async (permissions) => ({ can: (scope) => permissions.some(({ action }) => action === scope) }),
  } } } };
  await authorizeMediaOperation(strapi, operation('api-token:9'));
  await assert.rejects(authorizeMediaOperation(strapi, operation('api-token:9', 'delete')), denied);
  token.expiresAt = new Date(Date.now() - 1000).toISOString(); await assert.rejects(authorizeMediaOperation(strapi, operation('api-token:9')), denied);
  token = { type: 'read-only' }; await assert.rejects(authorizeMediaOperation(strapi, operation('api-token:9')), denied);
  token = null; await assert.rejects(authorizeMediaOperation(strapi, operation('api-token:9')), denied);
});
test('API users must still be confirmed, enabled and permitted by their current role', async () => {
  const user = { role: { id: 2 }, blocked: false, confirmed: true }; let allowed = true;
  const strapi = { plugin: () => ({ service: (name) => name === 'user' ? { fetchAuthenticatedUser: async () => user }
    : { findRolePermissions: async () => allowed ? [{ action: 'plugin::upload.content-api.upload' }] : [], toContentAPIPermission: (p) => p } }),
    store: () => ({ get: async () => ({ email_confirmation: true }) }), contentAPI: { permissions: { engine: {
      generateAbility: async (permissions) => ({ can: (scope) => permissions.some(({ action }) => action === scope) }),
    } } } };
  await authorizeMediaOperation(strapi, operation('user:3'));
  user.blocked = true; await assert.rejects(authorizeMediaOperation(strapi, operation('user:3')), denied);
  user.blocked = false; user.confirmed = false; await assert.rejects(authorizeMediaOperation(strapi, operation('user:3')), denied);
  user.confirmed = true; allowed = false; await assert.rejects(authorizeMediaOperation(strapi, operation('user:3')), denied);
});
test('an unavailable permission database remains distinguishable from a revoked permission', async () => {
  const failure = new Error('database unavailable');
  const strapi = { service: () => ({ findOne: async () => { throw failure; } }) };
  await assert.rejects(authorizeMediaOperation(strapi, operation()), (error) => error === failure);
  await authorizeMediaOperation({}, operation('internal'));
});
test('autonomous recovery makes revoked work terminal but preserves uncertainty on database failure', async () => {
  for (const [failure, terminal] of [[new RecoveryError(403, 'AUTHORIZATION_REVOKED', 'revoked'), true], [new Error('database unavailable'), false]] as const) {
    const engine = new MediaRecovery({ db: { connection: {} }, log: { warn() {} } }, {} as any);
    let first = true; let interrupted: any[] | undefined;
    engine.batches.claimExpired = async () => undefined;
    engine.journal.claimExpired = async () => { if (!first) return undefined; first = false; return { ...operation(), state: 'prepared' }; };
    engine.journal.commit = async () => { throw failure; };
    engine.journal.interrupt = async (...args) => { interrupted = args; };
    engine.journal.claimCleanup = async () => undefined;
    await engine.reconcile();
    if (terminal) assert.deepEqual(interrupted?.slice(1), [true, 'AUTHORIZATION_REVOKED']);
    else assert.equal(interrupted, undefined);
  }
});
