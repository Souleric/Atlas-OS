const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipcRenderer', ipcRenderer);

contextBridge.exposeInMainWorld('emailAPI', {
  getAccounts: () => ipcRenderer.invoke('email:get-accounts'),
  addAccount: (data) => ipcRenderer.invoke('email:add-account', data),
  removeAccount: (id) => ipcRenderer.invoke('email:remove-account', id),
  testAccount: (data) => ipcRenderer.invoke('email:test-account', data),
  fetchMessages: (accountId, mailbox, limit) => ipcRenderer.invoke('email:fetch-messages', { accountId, mailbox, limit }),
  fetchBody: (accountId, mailbox, uid) => ipcRenderer.invoke('email:fetch-body', { accountId, mailbox, uid }),
  send: (data) => ipcRenderer.invoke('email:send', data),
  markRead: (accountId, mailbox, uid) => ipcRenderer.invoke('email:mark-read', { accountId, mailbox, uid }),
  onNewMessages: (cb) => ipcRenderer.on('email:new-messages', (_, data) => cb(data)),
  onSyncStatus: (cb) => ipcRenderer.on('email:sync-status', (_, data) => cb(data)),
  ask: (data) => ipcRenderer.invoke('atlas:ask', data),
});
