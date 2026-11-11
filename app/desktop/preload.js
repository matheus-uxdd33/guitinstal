'use strict';

const { contextBridge } = require('electron');

/**
 * The renderer runs the same UI served by the local Node server, so it needs
 * no privileged bridge. Only harmless environment facts are exposed.
 */
contextBridge.exposeInMainWorld('guitinstal', {
  platform: process.platform,
  version: process.versions.electron || null,
});
