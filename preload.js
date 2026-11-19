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
  term: {
    run: a => ipcRenderer.send('term:run', a),
    input: t => ipcRenderer.send('term:in', t),
    stop: () => ipcRenderer.invoke('term:stop'),
    cd: a => ipcRenderer.invoke('term:cd', a),
    onEvent: cb => ipcRenderer.on('term:event', (e, ev) => cb(ev)),
  },
  claude: {
    status: () => ipcRenderer.invoke('claude:status'),
    login: () => ipcRenderer.invoke('claude:login'),
    remote: () => ipcRenderer.invoke('claude:remote'),
    send: msg => ipcRenderer.send('claude:send', msg),
    stop: id => ipcRenderer.invoke('claude:stop', id),
    onEvent: cb => ipcRenderer.on('claude:event', (e, ev) => cb(ev)),
  },
});
