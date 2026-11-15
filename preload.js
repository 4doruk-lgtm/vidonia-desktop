const { contextBridge, ipcRenderer } = require('electron');

// Exposes a small, safe API to the page. The page uses it when running as a desktop app.
contextBridge.exposeInMainWorld('vidoniaDesktop', {
  enhance: opts => ipcRenderer.invoke('enhance', opts),
  onProgress: cb => {
    const handler = (_event, pct) => cb(pct);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  }
});
