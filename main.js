const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const WATCHLIST_FILE = path.join(app.getPath('userData'), 'watchlist.json');
const SOUNDS_DIR = path.join(app.getPath('userData'), 'sounds');
fs.mkdirSync(SOUNDS_DIR, { recursive: true });

const POLL_INTERVAL_MS = 15000;

let mainWindow = null;
let tray = null;
let pollTimer = null;
let isQuitting = false;
let updateReady = false;
let manualCheckInProgress = false;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const DEFAULT_VOICE = 'chime';

let watchlist = loadWatchlist(); // [{ symbol, voiceUp, voiceDown, alertAbove, alertBelow }]
let lastQuotes = {}; // symbol -> last known quote, used to detect direction changes

// Per-symbol arm state for price-target alerts, so a target that stays
// crossed doesn't re-fire every poll — it re-arms once price crosses back.
let alertArmed = {}; // symbol -> { above: bool, below: bool }

function getArmState(symbol) {
    if (!alertArmed[symbol]) alertArmed[symbol] = { above: true, below: true };
    return alertArmed[symbol];
}

function loadWatchlist() {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8'));
    } catch {
        raw = ['AAPL', 'NVDA', 'BTC-USD'];
    }
    // Normalize every entry to the current shape, migrating older formats:
    // - plain symbol strings (pre-1.1.0)
    // - a single shared `voice` field (1.1.0/1.2.0) -> split into voiceUp/voiceDown
    // - custom uploaded sound files (added after 1.2.0) default to none
    return raw.map((entry) => {
        if (typeof entry === 'string') {
            return {
                symbol: entry, voiceUp: DEFAULT_VOICE, voiceDown: DEFAULT_VOICE,
                customUpFile: null, customUpName: null, customDownFile: null, customDownName: null,
                alertAbove: null, alertBelow: null,
            };
        }
        return {
            symbol: entry.symbol,
            voiceUp: entry.voiceUp ?? entry.voice ?? DEFAULT_VOICE,
            voiceDown: entry.voiceDown ?? entry.voice ?? DEFAULT_VOICE,
            customUpFile: entry.customUpFile ?? null,
            customUpName: entry.customUpName ?? null,
            customDownFile: entry.customDownFile ?? null,
            customDownName: entry.customDownName ?? null,
            alertAbove: entry.alertAbove ?? null,
            alertBelow: entry.alertBelow ?? null,
        };
    });
}

// Renderer never needs the raw stored filename — it needs a URL it can hand
// to <audio src>. Resolve that here rather than persisting an absolute path
// (which could break if userData ever moved) or leaking fs details out.
function serializeEntry(entry) {
    return {
        ...entry,
        customUpUrl: entry.customUpFile ? pathToFileURL(path.join(SOUNDS_DIR, entry.customUpFile)).href : null,
        customDownUrl: entry.customDownFile ? pathToFileURL(path.join(SOUNDS_DIR, entry.customDownFile)).href : null,
    };
}
function serializeWatchlist() {
    return watchlist.map(serializeEntry);
}

function deleteCustomFile(filename) {
    if (!filename) return;
    fs.rm(path.join(SOUNDS_DIR, filename), { force: true }, () => {}); // best-effort cleanup
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

function buildTrayMenu() {
    const items = [
        { label: 'Show LuxeTrade', click: () => mainWindow.show() },
        { label: 'Refresh Now', click: () => fetchPrices() },
        { label: 'Check for Updates', click: () => checkForUpdates(true) },
    ];
    if (updateReady) {
        items.push({ label: 'Restart && Install Update', click: () => { isQuitting = true; autoUpdater.quitAndInstall(); } });
    }
    items.push({ type: 'separator' }, { label: 'Quit', click: () => { isQuitting = true; app.quit(); } });
    return Menu.buildFromTemplate(items);
}

function createTray() {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(trayIcon);
    tray.setToolTip('LuxeTrade — Market Watch');
    tray.setContextMenu(buildTrayMenu());

    tray.on('click', () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
    });
}

// --- AUTO UPDATE ---
// `manual` distinguishes a user-clicked "Check for Updates" from the silent
// background poll, so we only notify "you're up to date" / show errors when
// the user actually asked — the periodic check should stay quiet otherwise.
function checkForUpdates(manual = false) {
    if (!app.isPackaged) {
        if (manual && Notification.isSupported()) {
            new Notification({
                title: 'LuxeTrade',
                body: 'Update checks only work in the installed app, not this dev build.',
                icon: path.join(__dirname, 'assets', 'icon.png'),
            }).show();
        }
        return;
    }

    manualCheckInProgress = manual;
    autoUpdater.checkForUpdates().catch((err) => {
        console.error('Update check failed:', err.message);
        if (manual && Notification.isSupported()) {
            new Notification({
                title: 'LuxeTrade',
                body: `Update check failed: ${err.message}`,
                icon: path.join(__dirname, 'assets', 'icon.png'),
            }).show();
        }
        manualCheckInProgress = false;
    });
}

autoUpdater.on('update-not-available', () => {
    if (manualCheckInProgress && Notification.isSupported()) {
        new Notification({
            title: 'LuxeTrade',
            body: "You're already on the latest version.",
            icon: path.join(__dirname, 'assets', 'icon.png'),
        }).show();
    }
    manualCheckInProgress = false;
});

autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err.message);
    manualCheckInProgress = false;
});

autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    manualCheckInProgress = false;
    tray?.setContextMenu(buildTrayMenu());
    if (Notification.isSupported()) {
        new Notification({
            title: 'LuxeTrade update ready',
            body: `Version ${info.version} downloaded — restart to install.`,
            icon: path.join(__dirname, 'assets', 'icon.png'),
        }).show();
    }
});

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

// Distinct from the routine up/down chime: a target alert is a deliberate
// threshold the user set, so it always shows a native notification (even
// while the window is focused) and re-arms only after price crosses back.
function checkPriceAlert(entry, price) {
    if (!entry) return;
    const arm = getArmState(entry.symbol);

    if (entry.alertAbove != null) {
        if (price >= entry.alertAbove && arm.above) {
            fireAlert(entry.symbol, 'above', price, entry.alertAbove);
            arm.above = false;
        } else if (price < entry.alertAbove) {
            arm.above = true;
        }
    }

    if (entry.alertBelow != null) {
        if (price <= entry.alertBelow && arm.below) {
            fireAlert(entry.symbol, 'below', price, entry.alertBelow);
            arm.below = false;
        } else if (price > entry.alertBelow) {
            arm.below = true;
        }
    }
}

function fireAlert(symbol, kind, price, target) {
    mainWindow?.webContents.send('alert:triggered', { symbol, kind, price, target });

    if (Notification.isSupported()) {
        new Notification({
            title: `🎯 ${symbol} target hit`,
            body: `${kind === 'above' ? 'Reached' : 'Dropped to'} $${price.toFixed(2)} (target $${target.toFixed(2)})`,
            icon: path.join(__dirname, 'assets', 'icon.png'),
            silent: true, // renderer plays a dedicated alert sound
        }).show();
    }
}

// --- FORECAST (statistical trend extrapolation, not a real prediction) ---
// Cache per-symbol so opening the forecast panel repeatedly within a short
// window doesn't hammer Yahoo with two extra history fetches every time.
const FORECAST_CACHE_MS = 60 * 1000;
let forecastCache = {}; // symbol -> { data, ts }

// --- Forecast accuracy tracking ---
// Every time a forecast is (re)built we log a snapshot, then once its target
// time has passed we compare it to whatever price we're seeing then. That's
// an approximation — we don't keep a full tick-by-tick history, so "actual"
// is just the live quote at (or shortly after) the target time — but it's
// enough to show whether this symbol's trend-following has been remotely
// useful, rather than asking the user to trust R^2 alone.
const FORECAST_HISTORY_FILE = path.join(app.getPath('userData'), 'forecast-history.json');
const MAX_HISTORY_PER_BUCKET = 50;
let forecastHistory = loadForecastHistory(); // { [symbol]: { intraday: Entry[], daily: Entry[] } }

function loadForecastHistory() {
    try {
        return JSON.parse(fs.readFileSync(FORECAST_HISTORY_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function saveForecastHistory() {
    fs.writeFileSync(FORECAST_HISTORY_FILE, JSON.stringify(forecastHistory));
}

// Throttled to roughly one sample per bar interval, so reopening the panel
// repeatedly doesn't flood the history with near-duplicate in-flight samples.
function recordForecastSample(symbol, horizon, summary, stepMs) {
    if (!summary) return;
    const now = Date.now();
    const targetT = summary.projected[summary.projected.length - 1]?.t ?? now;
    // When the underlying bars are stale (e.g. market closed for hours), the
    // projected target time can already be in the past the moment it's
    // computed — that would "resolve" instantly against whatever the live
    // quote happens to be, which isn't a real forecast-then-wait sample.
    if (targetT <= now) return;

    forecastHistory[symbol] ??= { intraday: [], daily: [] };
    const bucket = forecastHistory[symbol][horizon];
    const last = bucket[bucket.length - 1];
    if (last && now - last.generatedAt < stepMs) return;

    bucket.push({
        generatedAt: now,
        targetT,
        lastPrice: summary.lastPrice,
        forecastPrice: summary.forecastPrice,
        actualPrice: null,
        resolved: false,
    });
    if (bucket.length > MAX_HISTORY_PER_BUCKET) bucket.splice(0, bucket.length - MAX_HISTORY_PER_BUCKET);
    saveForecastHistory();
}

// Called on every price poll: sweeps all pending forecasts across the whole
// watchlist and resolves any whose target time has arrived using whatever
// quote we currently have for that symbol.
function resolvePendingForecasts() {
    let changed = false;
    for (const [symbol, horizons] of Object.entries(forecastHistory)) {
        const currentPrice = lastQuotes[symbol]?.price;
        if (currentPrice == null) continue;
        for (const bucket of Object.values(horizons)) {
            for (const entry of bucket) {
                if (entry.resolved || Date.now() < entry.targetT) continue;
                entry.actualPrice = currentPrice;
                entry.resolved = true;
                changed = true;
            }
        }
    }
    if (changed) saveForecastHistory();
}

function computeAccuracy(symbol, horizon) {
    const resolved = (forecastHistory[symbol]?.[horizon] || []).filter((e) => e.resolved);
    if (resolved.length < 3) return null; // too few samples to mean anything

    let errSum = 0, directionHits = 0;
    resolved.forEach((e) => {
        errSum += Math.abs((e.actualPrice - e.forecastPrice) / e.actualPrice) * 100;
        const forecastDir = Math.sign(e.forecastPrice - e.lastPrice);
        const actualDir = Math.sign(e.actualPrice - e.lastPrice);
        if (forecastDir !== 0 && forecastDir === actualDir) directionHits++;
    });

    return {
        count: resolved.length,
        avgErrorPct: errSum / resolved.length,
        directionAccuracyPct: (directionHits / resolved.length) * 100,
    };
}

async function fetchHistory(symbol, range, interval) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol} history`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No history for ${symbol}`);
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null) points.push({ t: timestamps[i] * 1000, price: closes[i] });
    }
    return points;
}

// Ordinary least squares of price against bar index. R^2 tells the UI how
// well a straight line actually fits — choppy/flat tape gets a low score,
// which matters more here than the slope itself since prices are close to
// a random walk and a "confident" trend line is often just noise.
function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;

    const xMean = (n - 1) / 2;
    const yMean = points.reduce((sum, p) => sum + p.price, 0) / n;
    let num = 0, sxx = 0;
    points.forEach((p, x) => {
        num += (x - xMean) * (p.price - yMean);
        sxx += (x - xMean) ** 2;
    });
    const slope = sxx === 0 ? 0 : num / sxx;
    const intercept = yMean - slope * xMean;

    let ssRes = 0, ssTot = 0;
    points.forEach((p, x) => {
        const pred = slope * x + intercept;
        ssRes += (p.price - pred) ** 2;
        ssTot += (p.price - yMean) ** 2;
    });
    const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
    const stdErr = Math.sqrt(ssRes / Math.max(1, n - 2));

    return { slope, intercept, r2, n, xMean, sxx, stdErr };
}

// Anchored to the actual last price (not the fitted line's value at that x),
// so the projection continues smoothly from where the price really is rather
// than jumping to wherever OLS says it "should" be. Each step also carries a
// widening uncertainty band (~90% OLS prediction interval) so the chart is
// honest that a point 2 hours out is far less certain than one 15 minutes out.
function projectForward(points, reg, stepsAhead, stepMs) {
    const last = points[points.length - 1];
    const projected = [];
    for (let i = 1; i <= stepsAhead; i++) {
        const x = reg.n - 1 + i;
        const price = last.price + reg.slope * i;
        const sePred = reg.sxx === 0
            ? reg.stdErr
            : reg.stdErr * Math.sqrt(1 + 1 / reg.n + ((x - reg.xMean) ** 2) / reg.sxx);
        const margin = 1.645 * sePred; // ~90% interval
        projected.push({ t: last.t + i * stepMs, price, lower: price - margin, upper: price + margin });
    }
    return projected;
}

function summarizeForecast(points, reg, projected) {
    if (!points.length || !reg) return null;
    const lastPrice = points[points.length - 1].price;
    const forecastPrice = projected.length ? projected[projected.length - 1].price : lastPrice;
    return {
        points,
        projected,
        lastPrice,
        forecastPrice,
        changePct: lastPrice ? ((forecastPrice - lastPrice) / lastPrice) * 100 : 0,
        r2: reg.r2,
    };
}

async function buildForecast(symbol) {
    const cached = forecastCache[symbol];
    if (cached && Date.now() - cached.ts < FORECAST_CACHE_MS) return cached.data;

    const [intradayRaw, dailyRaw] = await Promise.all([
        fetchHistory(symbol, '5d', '15m'),
        fetchHistory(symbol, '3mo', '1d'),
    ]);

    const INTRA_STEP_MS = 15 * 60 * 1000;
    const DAILY_STEP_MS = 24 * 60 * 60 * 1000;

    // Fit only the most recent session's bars so an overnight/weekend gap
    // isn't read as part of the intraday trend, then project a couple hours
    // of 15m bars ahead.
    const intradaySession = intradayRaw.slice(-26);
    const intraReg = linearRegression(intradaySession);
    const intraProjected = intraReg ? projectForward(intradaySession, intraReg, 10, INTRA_STEP_MS) : [];
    const intradaySummary = summarizeForecast(intradaySession, intraReg, intraProjected);

    // Fit the last ~6 weeks of daily closes and project 5 trading days out.
    const dailyWindow = dailyRaw.slice(-30);
    const dailyReg = linearRegression(dailyWindow);
    const dailyProjected = dailyReg ? projectForward(dailyWindow, dailyReg, 5, DAILY_STEP_MS) : [];
    const dailySummary = summarizeForecast(dailyWindow, dailyReg, dailyProjected);

    recordForecastSample(symbol, 'intraday', intradaySummary, INTRA_STEP_MS);
    recordForecastSample(symbol, 'daily', dailySummary, DAILY_STEP_MS);
    if (intradaySummary) intradaySummary.accuracy = computeAccuracy(symbol, 'intraday');
    if (dailySummary) dailySummary.accuracy = computeAccuracy(symbol, 'daily');

    const data = {
        symbol,
        generatedAt: Date.now(),
        intraday: intradaySummary,
        daily: dailySummary,
    };
    forecastCache[symbol] = { data, ts: Date.now() };
    return data;
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

        checkPriceAlert(watchlist[i], price);
    });

    lastQuotes = { ...lastQuotes, ...quotes };
    resolvePendingForecasts();
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
ipcMain.handle('watchlist:get', () => serializeWatchlist());

ipcMain.handle('watchlist:add', (_event, symbol) => {
    symbol = String(symbol).toUpperCase().trim();
    if (symbol && !watchlist.some((w) => w.symbol === symbol)) {
        watchlist.push({
            symbol, voiceUp: DEFAULT_VOICE, voiceDown: DEFAULT_VOICE,
            customUpFile: null, customUpName: null, customDownFile: null, customDownName: null,
            alertAbove: null, alertBelow: null,
        });
        saveWatchlist();
        fetchPrices();
    }
    return serializeWatchlist();
});

ipcMain.handle('watchlist:remove', (_event, symbol) => {
    const entry = watchlist.find((w) => w.symbol === symbol);
    if (entry) {
        deleteCustomFile(entry.customUpFile);
        deleteCustomFile(entry.customDownFile);
    }
    watchlist = watchlist.filter((w) => w.symbol !== symbol);
    delete lastQuotes[symbol];
    delete alertArmed[symbol];
    saveWatchlist();
    return serializeWatchlist();
});

ipcMain.handle('watchlist:setVoice', (_event, symbol, direction, voiceId) => {
    const entry = watchlist.find((w) => w.symbol === symbol);
    if (entry) {
        const fileKey = direction === 'up' ? 'customUpFile' : 'customDownFile';
        const nameKey = direction === 'up' ? 'customUpName' : 'customDownName';
        // Switching to a preset abandons any custom file that was set for this direction.
        if (voiceId !== 'custom' && entry[fileKey]) {
            deleteCustomFile(entry[fileKey]);
            entry[fileKey] = null;
            entry[nameKey] = null;
        }
        entry[direction === 'up' ? 'voiceUp' : 'voiceDown'] = voiceId;
        saveWatchlist();
    }
    return serializeWatchlist();
});

ipcMain.handle('watchlist:setAlert', (_event, symbol, { above, below }) => {
    const entry = watchlist.find((w) => w.symbol === symbol);
    if (entry) {
        entry.alertAbove = above;
        entry.alertBelow = below;
        alertArmed[symbol] = { above: true, below: true }; // re-arm on a new/changed target
        saveWatchlist();
    }
    return serializeWatchlist();
});

// Opens a native file picker, copies the chosen audio file into userData
// (so it survives the source file being moved/deleted), and assigns it as
// the custom sound for that stock + direction.
ipcMain.handle('sound:pickCustom', async (_event, symbol, direction) => {
    const entry = watchlist.find((w) => w.symbol === symbol);
    if (!entry) return serializeWatchlist();

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a custom alert sound',
        filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }],
        properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return serializeWatchlist();

    const sourcePath = result.filePaths[0];
    const storedName = `${crypto.randomUUID()}${path.extname(sourcePath)}`;
    fs.copyFileSync(sourcePath, path.join(SOUNDS_DIR, storedName));

    const fileKey = direction === 'up' ? 'customUpFile' : 'customDownFile';
    const nameKey = direction === 'up' ? 'customUpName' : 'customDownName';
    const voiceKey = direction === 'up' ? 'voiceUp' : 'voiceDown';

    deleteCustomFile(entry[fileKey]); // replace whatever custom file was there before
    entry[fileKey] = storedName;
    entry[nameKey] = path.basename(sourcePath);
    entry[voiceKey] = 'custom';

    saveWatchlist();
    return serializeWatchlist();
});

ipcMain.handle('prices:refresh', () => fetchPrices());

ipcMain.handle('forecast:get', async (_event, symbol) => {
    try {
        return { ok: true, data: await buildForecast(symbol) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

app.whenReady().then(() => {
    createWindow();
    createTray();
    startPolling();

    checkForUpdates();
    setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);

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
