import type { StrapiApp } from '@strapi/strapi/admin';
import { ArrowClockwise } from '@strapi/icons';

export default {
  register(app: StrapiApp) {
    app.addMenuLink({ to: 'plugins/gthf-media-recovery', icon: ArrowClockwise,
      intlLabel: { id: 'gthf.media-recovery', defaultMessage: 'Reprise des médias' },
      Component: () => import('./recovery/Page').then((module) => ({ default: module.default })),
      permissions: [{ action: 'plugin::upload.read', subject: null }],
    });
  },
};
