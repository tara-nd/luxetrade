const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('luxeAPI', {
    getWatchlist: () => ipcRenderer.invoke('watchlist:get'),
    addStock: (symbol) => ipcRenderer.invoke('watchlist:add', symbol),
    removeStock: (symbol) => ipcRenderer.invoke('watchlist:remove', symbol),
    setVoice: (symbol, direction, voiceId) => ipcRenderer.invoke('watchlist:setVoice', symbol, direction, voiceId),
    pickCustomSound: (symbol, direction) => ipcRenderer.invoke('sound:pickCustom', symbol, direction),
    setAlert: (symbol, { above, below }) => ipcRenderer.invoke('watchlist:setAlert', symbol, { above, below }),
    setPosition: (symbol, { shares, costBasis }) => ipcRenderer.invoke('watchlist:setPosition', symbol, { shares, costBasis }),
    refresh: () => ipcRenderer.invoke('prices:refresh'),
    getForecast: (symbol) => ipcRenderer.invoke('forecast:get', symbol),
    getSparkline: (symbol) => ipcRenderer.invoke('sparkline:get', symbol),
    getNews: () => ipcRenderer.invoke('news:get'),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    toggleHud: () => ipcRenderer.invoke('hud:toggle'),
    onPricesUpdate: (callback) => {
        ipcRenderer.on('prices:update', (_event, payload) => callback(payload));
    },
    onPricesError: (callback) => {
        ipcRenderer.on('prices:error', (_event, message) => callback(message));
    },
    onAlertTriggered: (callback) => {
        ipcRenderer.on('alert:triggered', (_event, payload) => callback(payload));
    },
});
