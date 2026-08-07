const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hudAPI', {
    getInitial: () => ipcRenderer.invoke('hud:getInitial'),
    onUpdate: (callback) => {
        ipcRenderer.on('hud:update', (_event, payload) => callback(payload));
    },
    requestClose: () => ipcRenderer.send('hud:requestClose'),
    openMain: () => ipcRenderer.invoke('hud:openMain'),
});
