const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const WATCHLIST_FILE = path.join(app.getPath('userData'), 'watchlist.json');
const POLL_INTERVAL_MS = 15000;

let mainWindow = null;
let tray = null;
let pollTimer = null;
let isQuitting = false;

const DEFAULT_VOICE = 'chime';

let watchlist = loadWatchlist(); // [{ symbol, voice }]
let lastQuotes = {}; // symbol -> last known quote, used to detect direction changes

function loadWatchlist() {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8'));
    } catch {
        raw = ['AAPL', 'NVDA', 'BTC-USD'];
    }
    // Migrate the old format (plain array of symbol strings) to {symbol, voice}.
    return raw.map((entry) =>
        typeof entry === 'string' ? { symbol: entry, voice: DEFAULT_VOICE } : entry
    );
}

function saveWatchlist() {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 860,
        minWidth: 720,
        minHeight: 560,
        backgroundColor: '#050505',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');

    // Hide to tray instead of quitting when the user closes the window.
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(trayIcon);
    tray.setToolTip('LuxeTrade — Market Watch');

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show LuxeTrade', click: () => mainWindow.show() },
        { label: 'Refresh Now', click: () => fetchPrices() },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
    });
}

const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// Yahoo's v7 batch quote endpoint now requires a signed-in cookie/crumb (401
// without it). The v8 per-symbol chart endpoint is still open, so we fetch
// each symbol individually and derive quote fields from its `meta` block.
async function fetchOneQuote(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error(`No data for ${symbol}`);
    return meta;
}

function deriveMarketState(meta) {
    const now = Date.now() / 1000;
    const period = meta.currentTradingPeriod;
    if (!period) return 'CLOSED';
    if (now >= period.regular.start && now < period.regular.end) return 'REGULAR';
    if (period.pre && now >= period.pre.start && now < period.pre.end) return 'PRE';
    if (period.post && now >= period.post.start && now < period.post.end) return 'POST';
    return 'CLOSED';
}

async function fetchPrices() {
    if (watchlist.length === 0) {
        mainWindow?.webContents.send('prices:update', { quotes: {}, marketOpen: false });
        return;
    }

    const symbols = watchlist.map((w) => w.symbol);
    const settled = await Promise.allSettled(symbols.map(fetchOneQuote));
    const quotes = {};
    let marketOpenCount = 0;
    let anyOk = false;

    settled.forEach((result, i) => {
        const symbol = symbols[i];
        if (result.status !== 'fulfilled') {
            console.error('Fetch error:', result.reason?.message);
            return;
        }
        anyOk = true;
        const meta = result.value;
        const price = meta.regularMarketPrice ?? 0;
        const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
        const prevPrice = lastQuotes[symbol]?.price;
        const marketState = deriveMarketState(meta);
        if (marketState === 'REGULAR') marketOpenCount++;

        let direction = null;
        if (prevPrice !== undefined) {
            if (price > prevPrice) direction = 'up';
            else if (price < prevPrice) direction = 'down';
        }

        const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

        quotes[symbol] = {
            price,
            change: changePercent,
            volume: meta.regularMarketVolume || 0,
            state: marketState,
            direction,
        };

        // Fire a native OS notification when the window isn't focused, so the
        // user still hears/sees the move without the app being in the foreground.
        if (direction && Notification.isSupported() && !mainWindow.isFocused()) {
            new Notification({
                title: `${symbol} ${direction === 'up' ? '▲' : '▼'} $${price.toFixed(2)}`,
                body: `${direction === 'up' ? 'Up' : 'Down'} to $${price.toFixed(2)} (${changePercent.toFixed(2)}%)`,
                icon: path.join(__dirname, 'assets', 'icon.png'),
                silent: true, // renderer plays its own chime; avoid a double sound
            }).show();
        }
    });

    lastQuotes = { ...lastQuotes, ...quotes };
    if (anyOk) {
        mainWindow?.webContents.send('prices:update', { quotes, marketOpen: marketOpenCount > 0 });
    } else {
        mainWindow?.webContents.send('prices:error', 'All symbol fetches failed');
    }
}

function startPolling() {
    fetchPrices();
    pollTimer = setInterval(fetchPrices, POLL_INTERVAL_MS);
}

// --- IPC handlers ---
ipcMain.handle('watchlist:get', () => watchlist);

ipcMain.handle('watchlist:add', (_event, symbol) => {
    symbol = String(symbol).toUpperCase().trim();
    if (symbol && !watchlist.some((w) => w.symbol === symbol)) {
        watchlist.push({ symbol, voice: DEFAULT_VOICE });
        saveWatchlist();
        fetchPrices();
    }
    return watchlist;
});

ipcMain.handle('watchlist:remove', (_event, symbol) => {
    watchlist = watchlist.filter((w) => w.symbol !== symbol);
    delete lastQuotes[symbol];
    saveWatchlist();
    return watchlist;
});

ipcMain.handle('watchlist:setVoice', (_event, symbol, voiceId) => {
    const entry = watchlist.find((w) => w.symbol === symbol);
    if (entry) {
        entry.voice = voiceId;
        saveWatchlist();
    }
    return watchlist;
});

ipcMain.handle('prices:refresh', () => fetchPrices());

app.whenReady().then(() => {
    createWindow();
    createTray();
    startPolling();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else mainWindow.show();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
    if (pollTimer) clearInterval(pollTimer);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
