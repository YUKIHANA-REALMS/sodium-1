import { Router, Request, Response } from 'express';
import { Module } from '../../handlers/moduleInit';
import prisma from '../../db';
import { isAuthenticated } from '../../handlers/utils/auth/authUtil';
import logger from '../../handlers/logger';

async function saveSettings(data: Record<string, any>) {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: data,
    create: {
      title: 'Sodium',
      ...data,
    },
  });
}

const indicloudModule: Module = {
  info: {
    name: 'IndiCloud Module',
    description: 'IndiCloud integration settings.',
    version: '1.0.0',
    moduleVersion: '1.0.0',
    author: 'IndiCloud',
    license: 'MIT',
  },

  router: () => {
    const router = Router();

    router.get(
      '/admin/indicloud',
      isAuthenticated(true),
      async (req: Request, res: Response) => {
        try {
          const userId = req.session?.user?.id;
          const user = await prisma.users.findUnique({ where: { id: userId } });
          if (!user) return res.redirect('/login');

          const settings = await prisma.settings.findUnique({ where: { id: 1 } });

          res.render('admin/indicloud/settings', { user, req, settings });
        } catch (error) {
          logger.error('Error loading IndiCloud settings page:', error);
          res.redirect('/admin/overview');
        }
      },
    );

    router.post(
      '/admin/indicloud',
      isAuthenticated(true),
      async (req: Request, res: Response) => {
        try {
          const { indicloudApiKey, indicloudBackupEnabled } = req.body;

          const data: Record<string, any> = {
            indicloudApiKey: indicloudApiKey || null,
            indicloudBackupEnabled: indicloudBackupEnabled === true || indicloudBackupEnabled === 'true',
          };

          await saveSettings(data);
          res.json({ success: true });
        } catch (error) {
          logger.error('Error saving IndiCloud settings:', error);
          res.status(500).json({ success: false, error: 'Failed to save settings.' });
        }
      },
    );

    return router;
  },
};

export default indicloudModule;
