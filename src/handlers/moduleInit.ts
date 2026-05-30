/**
 * ╳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╳
 *      Sodium - Open Source Project by IndiCloud
 *      Repository: https://github.com/indicloud/panel
 *
 *     © 2025 IndiCloud. Licensed under the MIT License
 * ╳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╳
 */

import { Router } from 'express';

interface ModuleInfo {
  name: string;
  description: string;
  version: string;
  moduleVersion: string;
  author: string;
  license: string;
}

export interface Module {
  info: ModuleInfo;
  router: () => Router;
}
