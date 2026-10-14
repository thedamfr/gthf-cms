import path from 'node:path';
import { mergeConfig, type UserConfig } from 'vite';
import { adminRecoveryPlugin } from '../../scripts/recovery/admin-adapter';

export default (config: UserConfig) => mergeConfig(config, {
  resolve: { alias: { '@gthf/media-recovery': path.resolve(process.cwd(), 'src/admin/recovery/client.ts') } },
  plugins: [adminRecoveryPlugin(process.cwd())],
});
