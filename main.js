const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const WATCHLIST_FILE = path.join(app.getPath('userData'), 'watchlist.json');
const SOUNDS_DIR = path.join(app.getPath('userData'), 'sounds');
fs.mkdirSync(SOUNDS_DIR, { recursive: true });
const HUD_STATE_FILE = path.join(app.getPath('userData'), 'hud-state.json');
const HUD_WIDTH = 260;
const HUD_HEIGHT = 360;

const POLL_INTERVAL_MS = 15000;

let mainWindow = null;
let tray = null;
let trayIconWindow = null; // hidden renderer used only to paint the live tray icon
let trayHistory = []; // recent avg watchlist %change samples, for the tray sparkline
let hudWindow = null; // floating always-on-top ticker
let pollTimer = null;
let isQuitting = false;
let updateReady = false;
let manualCheckInProgress = false;

const TRAY_HISTORY_MAX = 20;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const DEFAULT_VOICE = 'chime';

let watchlist = loadWatchlist(); // [{ symbol, voiceUp, voiceDown, alertAbove, alertBelow }]
let lastQuotes = {}; // symbol -> last known quote, used to detect direction changes
let hudState = loadHudState(); // { x, y, visible } — floating ticker HUD window

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
                alertAbove: null, alertBelow: null, shares: null, costBasis: null,
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
            // A position is optional — most watchlist entries are just
            // being watched, not held. null means "no position entered".
            shares: entry.shares ?? null,
            costBasis: entry.costBasis ?? null,
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

function loadHudState() {
    try {
        return JSON.parse(fs.readFileSync(HUD_STATE_FILE, 'utf-8'));
    } catch {
        return { x: null, y: null, visible: false };
    }
}

function saveHudState() {
    fs.writeFileSync(HUD_STATE_FILE, JSON.stringify(hudState));
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
        { label: hudWindow?.isVisible() ? 'Hide Ticker HUD' : 'Show Ticker HUD', click: () => toggleHud() },
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

// --- FLOATING TICKER HUD ---
// A small always-on-top, frameless window that stays visible over other
// apps — the one thing a browser-based terminal can't do. Created once and
// hidden/shown thereafter rather than destroyed, so its position survives
// toggling within a session; the position (and whether it was left open) is
// also persisted to disk so it comes back where you left it next launch.
function createHudWindow() {
    const display = screen.getPrimaryDisplay();
    const defaultX = display.workArea.x + display.workArea.width - HUD_WIDTH - 24;
    const defaultY = display.workArea.y + 24;

    hudWindow = new BrowserWindow({
        width: HUD_WIDTH,
        height: HUD_HEIGHT,
        x: hudState.x ?? defaultX,
        y: hudState.y ?? defaultY,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'hud-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    hudWindow.loadFile('hud.html');

    hudWindow.on('moved', () => {
        const [x, y] = hudWindow.getPosition();
        hudState.x = x;
        hudState.y = y;
        saveHudState();
    });

    // Treat the window-manager close (if the user ever gets a native close
    // affordance) the same as the in-panel close button — hide, don't destroy.
    hudWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            hideHud();
        }
    });

    if (hudState.visible) hudWindow.showInactive();
}

function showHud() {
    if (!hudWindow) return;
    hudWindow.showInactive(); // don't steal focus from whatever the user's doing
    hudState.visible = true;
    saveHudState();
    tray?.setContextMenu(buildTrayMenu());
}

function hideHud() {
    if (!hudWindow) return;
    hudWindow.hide();
    hudState.visible = false;
    saveHudState();
    tray?.setContextMenu(buildTrayMenu());
}

function toggleHud() {
    if (hudWindow?.isVisible()) hideHud();
    else showHud();
}

// --- LIVE TRAY ICON ---
// A tray icon is a static image, not a webpage — there's no way to paint a
// live sparkline into it directly. The trick: keep a hidden BrowserWindow
// (never shown, transparent) that draws the sparkline on a <canvas>, then
// screenshot that window with capturePage() and hand the resulting
// NativeImage to tray.setImage(). `transparent: true` on the window is what
// keeps capturePage()'s alpha channel intact instead of capturing a solid
// background.
function createTrayIconWindow() {
    trayIconWindow = new BrowserWindow({
        width: 32,
        height: 32,
        show: false,
        frame: false,
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'tray-icon-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    trayIconWindow.loadFile('tray-icon.html');
}

function updateTrayIcon(history) {
    if (!trayIconWindow || trayIconWindow.isDestroyed()) return;
    ipcMain.once('tray:ready', async () => {
        try {
            const image = await trayIconWindow.webContents.capturePage();
            tray?.setImage(image);
        } catch (err) {
            console.error('Tray icon capture failed:', err.message);
        }
    });
    trayIconWindow.webContents.send('tray:draw', history);
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

// --- MARKET INDEX STRIP ---
// Fixed set of macro indices shown regardless of the user's watchlist, so
// there's always market-wide context (not just whatever tickers they added).
const INDEX_SYMBOLS = [
    { symbol: '^GSPC', label: 'S&P 500' },
    { symbol: '^DJI', label: 'DOW' },
    { symbol: '^IXIC', label: 'NASDAQ' },
    { symbol: '^VIX', label: 'VIX' },
];

async function fetchIndices() {
    const settled = await Promise.allSettled(INDEX_SYMBOLS.map(({ symbol }) => fetchOneQuote(symbol)));
    const indices = {};
    settled.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const { symbol, label } = INDEX_SYMBOLS[i];
        const meta = result.value;
        const price = meta.regularMarketPrice ?? 0;
        const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
        const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        indices[symbol] = { label, price, change };
    });
    return indices;
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
            silent: true, // renderer plays that stock's configured alert voice
        }).show();
    }
}

// --- SPARKLINE (compact intraday price trace for the watchlist cards) ---
// Cached independently from the 15s price poll — a sparkline only needs to
// move every few minutes, so refreshing it on every tick would just be extra
// Yahoo load for no visible benefit.
const SPARKLINE_CACHE_MS = 5 * 60 * 1000;
let sparklineCache = {}; // symbol -> { points, ts }

async function getSparkline(symbol) {
    const cached = sparklineCache[symbol];
    if (cached && Date.now() - cached.ts < SPARKLINE_CACHE_MS) return cached.points;

    const points = await fetchHistory(symbol, '1d', '5m');
    sparklineCache[symbol] = { points, ts: Date.now() };
    return points;
}

// --- NEWS (headlines related to whatever's on the watchlist) ---
// Yahoo's `search` endpoint returns a `news` array alongside quote matches;
// requesting quotesCount=0 skips the quote-match work server-side since we
// only want the news half. Cached per-symbol like the sparkline, since
// headlines don't turn over fast enough to justify fetching on every tick.
const NEWS_CACHE_MS = 5 * 60 * 1000;
let newsCache = {}; // symbol -> { items, ts }

async function fetchSymbolNews(symbol) {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=6&quotesCount=0`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol} news`);
    const json = await res.json();
    return (json.news || [])
        // When Yahoo has no real match for the query it falls back to
        // generic trending stories instead of an empty list — those never
        // list the symbol in relatedTickers, so filtering on that is what
        // actually keeps this "news about your stock" instead of noise.
        .filter((n) => n.relatedTickers?.some((t) => t.toUpperCase() === symbol.toUpperCase()))
        .map((n) => ({
            uuid: n.uuid,
            title: n.title,
            publisher: n.publisher,
            link: n.link,
            time: n.providerPublishTime * 1000,
        }));
}

async function getSymbolNews(symbol) {
    const cached = newsCache[symbol];
    if (cached && Date.now() - cached.ts < NEWS_CACHE_MS) return cached.items;

    const items = await fetchSymbolNews(symbol);
    newsCache[symbol] = { items, ts: Date.now() };
    return items;
}

// Same story can show up under multiple watched tickers (e.g. a Fed story
// tagged under both SPX and individual stocks) — merge by uuid and track
// which of the user's symbols it's relevant to, rather than showing dupes.
async function getWatchlistNews() {
    const symbols = watchlist.map((w) => w.symbol);
    const settled = await Promise.allSettled(symbols.map(getSymbolNews));

    const merged = new Map();
    settled.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const symbol = symbols[i];
        result.value.forEach((item) => {
            if (merged.has(item.uuid)) merged.get(item.uuid).symbols.add(symbol);
            else merged.set(item.uuid, { ...item, symbols: new Set([symbol]) });
        });
    });

    return [...merged.values()]
        .map((item) => ({ ...item, symbols: [...item.symbols] }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 15);
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
    const symbols = watchlist.map((w) => w.symbol);
    const [settled, indices] = await Promise.all([
        Promise.allSettled(symbols.map(fetchOneQuote)),
        fetchIndices(),
    ]);

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
            dayLow: meta.regularMarketDayLow ?? null,
            dayHigh: meta.regularMarketDayHigh ?? null,
            weekLow: meta.fiftyTwoWeekLow ?? null,
            weekHigh: meta.fiftyTwoWeekHigh ?? null,
        };

        checkPriceAlert(watchlist[i], price);
    });

    lastQuotes = { ...lastQuotes, ...quotes };
    resolvePendingForecasts();
    // The index strip is independent of the watchlist, so it still goes out
    // even when there are no symbols to watch (or all of them failed).
    if (anyOk || watchlist.length === 0) {
        mainWindow?.webContents.send('prices:update', { quotes, marketOpen: marketOpenCount > 0, indices });
        hudWindow?.webContents.send('hud:update', { quotes, watchlist: serializeWatchlist() });
    } else {
        mainWindow?.webContents.send('prices:error', 'All symbol fetches failed');
    }

    const changes = Object.values(quotes).map((q) => q.change).filter((c) => Number.isFinite(c));
    if (changes.length > 0) {
        const avgChange = changes.reduce((sum, c) => sum + c, 0) / changes.length;
        trayHistory.push(avgChange);
        if (trayHistory.length > TRAY_HISTORY_MAX) trayHistory.shift();
        updateTrayIcon(trayHistory);
        tray?.setToolTip(`LuxeTrade — avg ${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(2)}% today`);
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
            alertAbove: null, alertBelow: null, shares: null, costBasis: null,
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

// Both fields travel together — a share count with no cost basis (or vice
// versa) can't produce a P&L figure, so the renderer only ever sends both
// or clears both.
ipcMain.handle('watchlist:setPosition', (_event, symbol, { shares, costBasis }) => {
    const entry = watchlist.find((w) => w.symbol === symbol);
    if (entry) {
        entry.shares = shares;
        entry.costBasis = costBasis;
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

ipcMain.handle('sparkline:get', async (_event, symbol) => {
    try {
        return { ok: true, data: await getSparkline(symbol) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('news:get', async () => {
    try {
        return { ok: true, data: await getWatchlistNews() };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Renderer has no Node/shell access (contextIsolation + nodeIntegration:false),
// so headline clicks route through here rather than a plain <a target="_blank">,
// which Electron would otherwise just block with no window to open it in.
ipcMain.handle('shell:openExternal', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('hud:toggle', () => {
    toggleHud();
    return hudWindow?.isVisible() ?? false;
});

ipcMain.handle('hud:getInitial', () => ({ watchlist: serializeWatchlist(), quotes: lastQuotes }));

ipcMain.handle('hud:openMain', () => mainWindow?.show());

ipcMain.on('hud:requestClose', () => hideHud());

app.whenReady().then(() => {
    createWindow();
    createTray();
    createTrayIconWindow();
    createHudWindow();
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
