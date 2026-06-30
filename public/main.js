/**
 * Wheel Edge — Electron Main Process
 *
 * In production:  starts the embedded Express/Tiger server, then opens the
 *                 packaged React build.
 * In development: opens http://localhost:3000 (react-scripts dev server).
 *
 * Run `npm run build:desktop` to produce the Windows installer.
 */

'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const isDev  = require('electron-is-dev');
const http   = require('http');

// ── Globals ──────────────────────────────────────────────────────────────────

let mainWindow   = null;
let apiServer    = null;   // Express http.Server instance
const API_PORT   = 3001;

// ── Embedded API Server ───────────────────────────────────────────────────────
// Starts the Tiger/Express backend inline — no child process needed.
// In production the server modules live in the asar bundle alongside main.js.

function startApiServer() {
  try {
    const express = require('express');
    const cors    = require('cors');

    // Resolve tigeropen from wherever it was installed
    const tigerBase = path.dirname(require.resolve('tigeropen'));
    const { createClientConfig } = require(path.join(tigerBase, 'config/client-config'));
    const { HttpClient }         = require(path.join(tigerBase, 'client/http-client'));
    const { QuoteClient }        = require(path.join(tigerBase, 'quote/quote-client'));
    const { TradeClient }        = require(path.join(tigerBase, 'trade/trade-client'));
    const { RetryPolicy }        = require(path.join(tigerBase, 'client/retry'));

    const NO_RETRY = new RetryPolicy({ maxRetries: 0 });

    // Config file lives next to the executable in production (extraResources)
    const configPath = isDev
      ? path.join(__dirname, '..', 'tiger_openapi_config.properties')
      : path.join(process.resourcesPath, 'tiger_openapi_config.properties');

    let quoteClient = null;
    let tradeClient = null;
    let initError   = null;

    try {
      const config   = createClientConfig({ propertiesFilePath: configPath });
      const quoteHttp = new HttpClient(config, NO_RETRY, { useQuoteServerUrl: true });
      const tradeHttp = new HttpClient(config, NO_RETRY);
      quoteClient = new QuoteClient(quoteHttp);
      tradeClient = new TradeClient(tradeHttp, config.account);
      console.log(`✅ Tiger API ready  — ID ${config.tigerId}`);
    } catch (err) {
      initError = err.message;
      console.warn('⚠ Tiger API init failed:', initError);
    }

    const expressApp = express();
    expressApp.use(cors({ origin: '*' }));
    expressApp.use(express.json());

    const requireClient = (req, res, next) => {
      if (!quoteClient) return res.status(503).json({ error: 'Tiger API not initialised', detail: initError });
      next();
    };

    expressApp.get('/api/status', (_req, res) => {
      if (!quoteClient) return res.json({ connected: false, error: initError });
      res.json({ connected: true, timestamp: new Date().toISOString() });
    });

    expressApp.get('/api/ping', requireClient, async (_req, res) => {
      try {
        const states = await quoteClient.getMarketState('US');
        res.json({ connected: true, marketState: states?.[0] ?? null, timestamp: new Date().toISOString() });
      } catch (err) {
        res.json({ connected: false, error: err.message, timestamp: new Date().toISOString() });
      }
    });

    expressApp.get('/api/quote/:symbol', requireClient, async (req, res) => {
      try {
        const briefs = await quoteClient.getBrief({ symbols: [req.params.symbol] });
        const b = briefs?.[0];
        if (!b) return res.status(404).json({ error: `No data for ${req.params.symbol}` });
        res.json({ symbol: b.symbol, price: b.latestPrice ?? b.preClose ?? null, bid: b.bidPrice ?? null, ask: b.askPrice ?? null, volume: b.volume ?? null, dayChange: b.change ?? null, dayChangePercent: b.changeRatio ?? null, timestamp: Date.now(), source: 'live' });
      } catch (err) {
        res.status(err.code === 4 ? 403 : 500).json({ error: err.message, code: err.code, needsSetup: err.code === 4 });
      }
    });

    expressApp.get('/api/quotes', requireClient, async (req, res) => {
      const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!symbols.length) return res.status(400).json({ error: 'symbols required' });
      try {
        const briefs = await quoteClient.getBrief({ symbols });
        res.json(briefs.map(b => ({ symbol: b.symbol, price: b.latestPrice ?? b.preClose ?? null, bid: b.bidPrice ?? null, ask: b.askPrice ?? null, timestamp: Date.now() })));
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    expressApp.get('/api/positions', async (_req, res) => {
      if (!tradeClient) return res.status(503).json({ error: 'Tiger not initialised', useMock: true, positions: [] });
      try {
        const positions = await tradeClient.getPositions();
        res.json({
          positions: (positions || []).map(p => ({
            symbol: p.symbol, secType: p.secType || 'STK',
            quantity: p.positionQty ?? p.position ?? 0,
            averageCost: p.averageCost ?? 0, marketValue: p.marketValue ?? 0,
            latestPrice: p.latestPrice ?? 0, unrealizedPnl: p.unrealizedPnl ?? 0,
            realizedPnl: p.realizedPnl ?? 0, currency: p.currency || 'USD',
          })),
          source: 'live',
        });
      } catch (err) {
        res.status(err.code === 4 ? 403 : 500).json({ error: err.message, useMock: true, positions: [] });
      }
    });

    expressApp.get('/api/market-state', requireClient, async (req, res) => {
      try { res.json(await quoteClient.getMarketState(req.query.market || 'US')); }
      catch (err) { res.status(500).json({ error: err.message }); }
    });

    apiServer = http.createServer(expressApp);
    apiServer.listen(API_PORT, '127.0.0.1', () => {
      console.log(`🚀 API server listening on http://127.0.0.1:${API_PORT}`);
    });

  } catch (err) {
    console.error('Failed to start API server:', err.message);
  }
}

// ── Window creation ───────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1440,
    height:    900,
    minWidth:  1280,
    minHeight: 720,
    frame:     true,
    title:     'Wheel Edge — Trading Dashboard',
    webPreferences: {
      preload:            path.join(__dirname, 'preload.js'),
      nodeIntegration:    false,
      contextIsolation:   true,
      enableRemoteModule: false,
      webSecurity:        true,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,   // show after ready-to-show to avoid white flash
  });

  // Load the right URL
  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;

  mainWindow.loadURL(startUrl);

  // Show window only when fully loaded (avoids white flash)
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Dev tools in development only
  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Application menu ──────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Quit Wheel Edge', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        ...(isDev ? [{ role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Wheel Edge',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type:    'info',
              title:   'Wheel Edge',
              message: `Wheel Edge — Trading Dashboard\nVersion ${app.getVersion()}\n\nBuilt for wheel strategy options traders.`,
              buttons: ['OK'],
            });
          },
        },
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-app-path',    () => app.getAppPath());
ipcMain.handle('get-user-data',   () => app.getPath('userData'));

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('maximize-window', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('close-window', () => mainWindow?.close());

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Start the API server first (non-blocking)
  if (!isDev) startApiServer();   // In dev, server.js is run separately via npm run server
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  // Shut down API server gracefully
  if (apiServer) apiServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (apiServer) apiServer.close();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
