const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('@vscode/sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const si = require('systeminformation');
const cors = require('cors');
const WebSocket = require('ws');
const PORT = 3001;
const DB_PATH = path.join(__dirname, 'panel.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const SECRET_KEY = process.env.JWT_SECRET || 'dev-secret';
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
let db;
async function initDb() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS routers (
    id TEXT PRIMARY KEY,
    name TEXT,
    host TEXT,
    user TEXT,
    password TEXT,
    port INTEGER,
    api_type TEXT
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT,
    message TEXT,
    is_read INTEGER,
    timestamp TEXT,
    link_to TEXT,
    context_json TEXT
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value_json TEXT
  )`);
}
function logRequest(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}
function protect(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    jwt.verify(token, SECRET_KEY);
    next();
  } catch (e) {
    res.status(401).json({ message: 'Unauthorized' });
  }
}
async function startServer() {
  await initDb();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(logRequest);
  const authRouter = express.Router();
  authRouter.get('/has-users', async (req, res) => {
    try {
      const row = await db.get('SELECT COUNT(*) as count FROM users');
      res.json({ hasUsers: (row?.count || 0) > 0 });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
  authRouter.post('/register', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ message: 'Missing credentials' });
      const id = `user_${Date.now()}`;
      const hash = await bcrypt.hash(password, 10);
      await db.run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)', [id, username, hash, 'admin']);
      const token = jwt.sign({ sub: id, username }, SECRET_KEY, { expiresIn: '7d' });
      res.json({ token });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
  authRouter.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ message: 'Missing credentials' });
      const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
      if (!user) return res.status(401).json({ message: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
      const token = jwt.sign({ sub: user.id, username }, SECRET_KEY, { expiresIn: '7d' });
      res.json({ token });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
  authRouter.get('/status', protect, async (req, res) => {
    res.json({ authenticated: true });
  });
  app.use('/api/auth', authRouter);
  const dbRouter = express.Router();
  dbRouter.use(protect);
  function createCrud(route, table) {
    const r = express.Router();
    r.get('/', async (req, res) => {
      try {
        const query = req.query || {};
        let sql = `SELECT * FROM ${table}`;
        const keys = Object.keys(query);
        if (keys.length) sql += ' WHERE ' + keys.map(k => `${k} = ?`).join(' AND ');
        const rows = await db.all(sql, keys.map(k => query[k]));
        res.json(rows);
      } catch (e) { res.status(500).json({ message: e.message }); }
    });
    r.get('/:id', async (req, res) => {
      try {
        const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
        if (!row) return res.status(404).json({ message: 'Not found' });
        res.json(row);
      } catch (e) { res.status(500).json({ message: e.message }); }
    });
    r.post('/', async (req, res) => {
      try {
        const data = req.body || {};
        const cols = Object.keys(data);
        const placeholders = cols.map(() => '?').join(',');
        await db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(k => data[k]));
        res.json({ message: 'Created' });
      } catch (e) { res.status(500).json({ message: e.message }); }
    });
    r.patch('/:id', async (req, res) => {
      try {
        const data = req.body || {};
        const cols = Object.keys(data);
        if (!cols.length) return res.status(400).json({ message: 'No fields' });
        await db.run(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map(k => data[k]), req.params.id]);
        res.json({ message: 'Updated' });
      } catch (e) { res.status(500).json({ message: e.message }); }
    });
    r.delete('/:id', async (req, res) => {
      try {
        await db.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
        res.json({ message: 'Deleted' });
      } catch (e) { res.status(500).json({ message: e.message }); }
    });
    dbRouter.use(route, r);
  }
  createCrud('/routers', 'routers');
  createCrud('/notifications', 'notifications');
  dbRouter.get('/panel-settings', async (req, res) => {
    try {
      const row = await db.get('SELECT value_json FROM kv_store WHERE key = ?', ['panel_settings']);
      res.json(row ? JSON.parse(row.value_json) : {});
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  dbRouter.post('/panel-settings', async (req, res) => {
    try {
      const val = JSON.stringify(req.body || {});
      await db.run('INSERT INTO kv_store (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', ['panel_settings', val]);
      res.json({ message: 'Saved' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  dbRouter.get('/company-settings', async (req, res) => {
    try {
      const row = await db.get('SELECT value_json FROM kv_store WHERE key = ?', ['company_settings']);
      res.json(row ? JSON.parse(row.value_json) : {});
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  dbRouter.post('/company-settings', async (req, res) => {
    try {
      const val = JSON.stringify(req.body || {});
      await db.run('INSERT INTO kv_store (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', ['company_settings', val]);
      res.json({ message: 'Saved' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.use('/api/db', dbRouter);
  app.get('/api/public/routers', async (req, res) => {
    try {
      const rows = await db.all('SELECT id, name FROM routers');
      res.json(rows.map(r => ({ id: r.id, name: r.name })));
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.get('/api/current-version', async (req, res) => {
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      res.json({ version: pkg.version || '0.0.0' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.get('/api/list-backups', protect, async (req, res) => {
    try {
      const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.zip') || f.endsWith('.tar.gz') || f.endsWith('.bak')) : [];
      res.json(files);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.post('/api/delete-backup', protect, async (req, res) => {
    try {
      const { backupFile } = req.body || {};
      if (!backupFile) return res.status(400).json({ message: 'backupFile required' });
      const target = path.join(BACKUP_DIR, path.basename(backupFile));
      if (!fs.existsSync(target)) return res.status(404).json({ message: 'Not found' });
      fs.unlinkSync(target);
      res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  const mtApiRouter = express.Router();
  mtApiRouter.use(protect);
  mtApiRouter.all('/:routerId/:endpoint(*)', async (req, res) => {
    try {
      const url = `http://localhost:3002/${req.params.routerId}/${req.params.endpoint}`;
      const response = await axios.request({
        method: req.method,
        url,
        data: req.body,
        validateStatus: () => true,
        headers: { Authorization: req.headers.authorization || '' }
      });
      res.status(response.status).send(response.data);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
  app.use('/mt-api', mtApiRouter);
  app.get('/api/zt/status', protect, async (req, res) => {
    try {
      res.json({ installed: false, running: false, networks: [] });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.post('/api/zt/join', protect, async (req, res) => {
    try {
      const { networkId } = req.body || {};
      if (!networkId) return res.status(400).json({ message: 'networkId required' });
      res.json({ message: 'Joined (stub)' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.get('/api/ngrok/status', protect, async (req, res) => {
    try {
      const row = await db.get('SELECT value_json FROM kv_store WHERE key = ?', ['ngrok_settings']);
      const settings = row ? JSON.parse(row.value_json) : { authtoken: '', proto: 'http', port: 3001 };
      res.json({ installed: false, active: false, public_url: null, settings });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.post('/api/ngrok/settings', protect, async (req, res) => {
    try {
      const val = JSON.stringify(req.body || {});
      await db.run('INSERT INTO kv_store (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', ['ngrok_settings', val]);
      res.json({ message: 'Saved' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.post('/api/ngrok/control/:action', protect, async (req, res) => {
    try {
      const { action } = req.params;
      if (!['start','stop','restart'].includes(action)) return res.status(400).json({ message: 'Invalid action' });
      res.json({ message: `Ngrok ${action} requested (stub)` });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  function sse(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }
  app.get('/api/ngrok/install', protect, async (req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ step: 'download', message: 'Downloading ngrok...' })}\n\n`);
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ step: 'install', message: 'Installing service...' })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ step: 'done', message: 'Installation complete.' })}\n\n`);
        res.end();
      }, 500);
    }, 500);
  });
  app.get('/api/ngrok/uninstall', protect, async (req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ step: 'stop', message: 'Stopping service...' })}\n\n`);
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ step: 'remove', message: 'Removing files...' })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ step: 'done', message: 'Uninstallation complete.' })}\n\n`);
        res.end();
      }, 500);
    }, 500);
  });
  app.get('/api/pitunnel/uninstall', protect, async (req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ step: 'stop', message: 'Stopping PiTunnel...' })}\n\n`);
    setTimeout(() => { res.write(`data: ${JSON.stringify({ step: 'done', message: 'PiTunnel removed.' })}\n\n`); res.end(); }, 500);
  });
  app.post('/api/pitunnel/tunnels/create', protect, async (req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ step: 'create', message: 'Creating tunnel...' })}\n\n`);
    setTimeout(() => { res.write(`data: ${JSON.stringify({ step: 'done', message: 'Tunnel created.' })}\n\n`); res.end(); }, 500);
  });
  app.post('/api/xendit/invoice', protect, async (req, res) => {
    try {
      const now = Date.now();
      res.json({ id: `inv_${now}`, status: 'PENDING', invoice_url: `https://example.com/invoice/${now}` });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  app.get('/api/host-status', protect, async (req, res) => {
    try {
      const [mem, cpu] = await Promise.all([si.mem(), si.currentLoad()]);
      res.json({ memory: { total: mem.total, used: mem.used }, cpu: { currentLoad: cpu.currentLoad } });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
  const frontendDistPath = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(frontendDistPath)) {
    const appStatic = express.static(frontendDistPath);
    app.use(appStatic);
  }
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (request, socket) => {
    socket.destroy();
  });
}
startServer();
