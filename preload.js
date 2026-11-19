const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('fm', {
  call: (name, arg) => ipcRenderer.invoke('call', name, arg),
  startDrag: paths => ipcRenderer.send('drag', paths),
  fileUrl: p => pathToFileURL(p).href,
  look: l => ipcRenderer.send('look', l),
  root: {
    get: () => ipcRenderer.invoke('root:get'),
    set: p => ipcRenderer.invoke('root:set', p),
    choose: () => ipcRenderer.invoke('root:choose'),
  },
  claude: {
    status: () => ipcRenderer.invoke('claude:status'),
    login: () => ipcRenderer.invoke('claude:login'),
    remote: () => ipcRenderer.invoke('claude:remote'),
    send: msg => ipcRenderer.send('claude:send', msg),
    stop: () => ipcRenderer.invoke('claude:stop'),
    onEvent: cb => ipcRenderer.on('claude:event', (e, ev) => cb(ev)),
  },
});
