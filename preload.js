const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('luxeAPI', {
    getWatchlist: () => ipcRenderer.invoke('watchlist:get'),
    addStock: (symbol) => ipcRenderer.invoke('watchlist:add', symbol),
    removeStock: (symbol) => ipcRenderer.invoke('watchlist:remove', symbol),
    setVoice: (symbol, voiceId) => ipcRenderer.invoke('watchlist:setVoice', symbol, voiceId),
    refresh: () => ipcRenderer.invoke('prices:refresh'),
    onPricesUpdate: (callback) => {
        ipcRenderer.on('prices:update', (_event, payload) => callback(payload));
    },
    onPricesError: (callback) => {
        ipcRenderer.on('prices:error', (_event, message) => callback(message));
    },
});
