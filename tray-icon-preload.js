const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the hidden tray-icon renderer: receive a history array
// to draw, and signal back once the canvas has actually been painted (main
// process waits for this before calling capturePage(), otherwise it could
// screenshot the canvas mid-draw or before the first frame).
contextBridge.exposeInMainWorld('trayAPI', {
    onDraw: (callback) => {
        ipcRenderer.on('tray:draw', (_event, history) => callback(history));
    },
    ready: () => ipcRenderer.send('tray:ready'),
});
