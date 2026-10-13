import assert from 'node:assert/strict';
import test from 'node:test';
import extend from '../src/extensions/upload/strapi-server';

test('committed replay skips telemetry and AI while ordinary calls preserve their behavior', async () => {
  const ctx = { state: { gthfMediaCommittedReplay: false } };
  let telemetry = 0; let aiChecks = 0;
  const plugin = extend({ services: { upload: () => ({}), metrics: () => ({ trackUsage: async () => { telemetry++; return 'sent'; } }),
    aiMetadata: () => ({ isEnabled: async () => { aiChecks++; return true; } }) }, controllers: { 'admin-file': { destroy() {} }, 'admin-folder-file': { deleteMany() {} } }, routes: { admin: { routes: [] } } });
  const context = { strapi: { requestContext: { get: () => ctx } } };
  const metrics = plugin.services.metrics(context); const ai = plugin.services.aiMetadata(context);
  assert.equal(await metrics.trackUsage('upload'), 'sent'); assert.equal(await ai.isEnabled(), true);
  ctx.state.gthfMediaCommittedReplay = true;
  assert.equal(await metrics.trackUsage('upload'), undefined); assert.equal(await ai.isEnabled(), false);
  assert.equal(telemetry, 1); assert.equal(aiChecks, 1);
  ctx.state.gthfMediaCommittedReplay = false;
  assert.equal(await ai.isEnabled(), true); assert.equal(aiChecks, 2);
});
