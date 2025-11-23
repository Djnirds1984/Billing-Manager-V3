
const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const sqlite3 = require('@vscode/sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');
const { Xendit } = require('xendit-node');
const si = require('systeminformation');
const cors = require('cors');
const { RouterOSAPI } = require('node-routeros-v2');
const WebSocket = require('ws');
const { Client } = require('ssh2');


const PORT = 3001;
const DB_PATH = path.join(__dirname, 'panel.db');
const SUPERADMIN_DB_PATH = path.join(__dirname, 'superadmin.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const SECRET_KEY = process.env.JWT_SECRET || 'a-very-weak-secret-key-for-dev-only';
const LICENSE_SECRET_KEY = process.env.LICENSE_SECRET || 'a-long-and-very-secret-string-for-licenses-!@#$%^&*()';

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

let db;
let superadminDb;

// --- Database Initialization ---
async function initSuperadminDb() {
    try {
        superadminDb = await open({
            filename: SUPERADMIN_DB_PATH,
            driver: sqlite3.Database
        });
        await superadminDb.exec('CREATE TABLE IF NOT EXISTS superadmin (username TEXT PRIMARY KEY, password TEXT NOT NULL);');
        const superadminUser = await superadminDb.get("SELECT COUNT(*) as count FROM superadmin");
        if (superadminUser.count === 0) {
            const defaultPassword = 'Akoangnagwagi84%';
            const hashedPassword = await bcrypt.hash(defaultPassword, 10);
            await superadminDb.run('INSERT INTO superadmin (username, password) VALUES (?, ?)', 'superadmin', hashedPassword);
            console.log('Superadmin user created with default secured password.');
        }
    } catch (err) {
        console.error('Failed to initialize superadmin database:', err);
        throw err;
    }
}

async function initDb() {
    try {
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        await db.exec('PRAGMA journal_mode = WAL;');

        await db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                language TEXT DEFAULT 'en',
                currency TEXT DEFAULT 'USD',
                geminiApiKey TEXT,
                licenseKey TEXT,
                companyName TEXT,
                address TEXT,
                contactNumber TEXT,
                email TEXT,
                logoBase64 TEXT,
                telegramSettings TEXT,
                xenditSettings TEXT,
                databaseEngine TEXT DEFAULT 'sqlite',
                dbHost TEXT,
                dbPort INTEGER,
                dbUser TEXT,
                dbPassword TEXT,
                dbName TEXT,
                notificationSettings TEXT
            );
            INSERT OR IGNORE INTO settings (id) VALUES (1);
        `);
        
        const columns = await db.all("PRAGMA table_info(settings)");
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('telegramSettings')) await db.exec("ALTER TABLE settings ADD COLUMN telegramSettings TEXT");
        if (!columnNames.includes('xenditSettings')) await db.exec("ALTER TABLE settings ADD COLUMN xenditSettings TEXT");
        if (!columnNames.includes('databaseEngine')) await db.exec("ALTER TABLE settings ADD COLUMN databaseEngine TEXT DEFAULT 'sqlite'");
        if (!columnNames.includes('notificationSettings')) await db.exec("ALTER TABLE settings ADD COLUMN notificationSettings TEXT");

        await db.exec(`
            CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT);
            CREATE TABLE IF NOT EXISTS permissions (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT);
            CREATE TABLE IF NOT EXISTS role_permissions (role_id TEXT, permission_id TEXT, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role_id TEXT, FOREIGN KEY (role_id) REFERENCES roles(id));
        `);

        const rolesCount = await db.get("SELECT COUNT(*) as count FROM roles");
        if (rolesCount.count === 0) {
            await db.run("INSERT INTO roles (id, name, description) VALUES (?, ?, ?)", 'role_admin', 'Administrator', 'Full access to all features');
            await db.run("INSERT INTO roles (id, name, description) VALUES (?, ?, ?)", 'role_employee', 'Employee', 'Limited access');
            await db.run("INSERT INTO permissions (id, name, description) VALUES (?, ?, ?)", 'perm_all', '*:*', 'All Permissions');
            await db.run("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)", 'role_admin', 'perm_all');
        }

        await db.exec(`
            CREATE TABLE IF NOT EXISTS routers (id TEXT PRIMARY KEY, name TEXT, host TEXT, user TEXT, password TEXT, port INTEGER, api_type TEXT);
            CREATE TABLE IF NOT EXISTS billing_plans (id TEXT PRIMARY KEY, routerId TEXT, name TEXT NOT NULL, price REAL NOT NULL, cycle TEXT NOT NULL, pppoeProfile TEXT, description TEXT, currency TEXT);
            CREATE TABLE IF NOT EXISTS sales_records (id TEXT PRIMARY KEY, routerId TEXT, date TEXT NOT NULL, clientName TEXT NOT NULL, planName TEXT NOT NULL, planPrice REAL NOT NULL, discountAmount REAL DEFAULT 0, finalAmount REAL NOT NULL, routerName TEXT, currency TEXT, clientAddress TEXT, clientContact TEXT, clientEmail TEXT);
            CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER DEFAULT 0, price REAL, serialNumber TEXT, dateAdded TEXT);
            CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, date TEXT NOT NULL, category TEXT, description TEXT, amount REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, fullName TEXT NOT NULL, role TEXT, hireDate TEXT, salaryType TEXT, rate REAL);
            CREATE TABLE IF NOT EXISTS employee_benefits (id TEXT PRIMARY KEY, employeeId TEXT, sss BOOLEAN, philhealth BOOLEAN, pagibig BOOLEAN, FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS time_records (id TEXT PRIMARY KEY, employeeId TEXT, date TEXT, timeIn TEXT, timeOut TEXT, FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, username TEXT UNIQUE, routerId TEXT, fullName TEXT, address TEXT, contactNumber TEXT, email TEXT);
            CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, type TEXT, message TEXT, is_read INTEGER DEFAULT 0, timestamp TEXT, link_to TEXT, context_json TEXT);
            CREATE TABLE IF NOT EXISTS dhcp_billing_plans (id TEXT PRIMARY KEY, routerId TEXT, name TEXT NOT NULL, price REAL NOT NULL, cycle_days INTEGER NOT NULL, speedLimit TEXT, currency TEXT);
            CREATE TABLE IF NOT EXISTS dhcp_clients (id TEXT PRIMARY KEY, routerId TEXT, macAddress TEXT, customerInfo TEXT, contactNumber TEXT, email TEXT, speedLimit TEXT, lastSeen TEXT, UNIQUE(routerId, macAddress));
        `);
        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Failed to initialize database:', err);
        throw err;
    }
}

// --- Helpers & Middleware ---
const getDeviceId = () => {
    const networkInterfaces = os.networkInterfaces();
    let macs = [];
    const ignoredInterfacePattern = /^(zt|docker|veth|br-|tun|tap|lo)/i;
    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
        if (ignoredInterfacePattern.test(name)) continue;
        for (const iface of interfaces) {
            if (iface.mac && iface.mac !== '00:00:00:00:00:00' && !iface.internal) {
                macs.push(iface.mac);
            }
        }
    }
    macs.sort();
    const uniqueId = macs.join('') || (os.hostname() + os.arch() + os.platform());
    return crypto.createHash('sha256').update(uniqueId).digest('hex');
};

const protect = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authentication required.' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid or expired token.' });
        req.user = user;
        next();
    });
};

const requireSuperadmin = (req, res, next) => {
    if (req.user?.role?.name?.toLowerCase() !== 'superadmin') {
        return res.status(403).json({ message: 'Access denied. Superadmin privileges required.' });
    }
    next();
};

// --- Main Application Logic ---
async function startServer() {
    await Promise.all([initDb(), initSuperadminDb()]);
    const app = express();

    app.use(cors());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ limit: '10mb' }));

    // --- AUTH ROUTES (Unprotected) ---
    const authRouter = express.Router();
    authRouter.post('/login', async (req, res) => { /* ... (same as before) */ });
    authRouter.post('/register', async (req, res) => { /* ... (same as before) */ });
    authRouter.get('/has-users', async (req, res) => { /* ... (same as before) */ });
    authRouter.get('/status', protect, (req, res) => res.json(req.user));
    app.use('/api/auth', authRouter);

    // --- DATABASE API (Protected) ---
    const dbRouter = express.Router();
    dbRouter.use(protect);
    const createCrud = (route, table) => { /* ... (same as before) */ };
    createCrud('/billing-plans', 'billing_plans');
    createCrud('/inventory', 'inventory');
    createCrud('/expenses', 'expenses');
    createCrud('/employees', 'employees');
    createCrud('/customers', 'customers');
    createCrud('/routers', 'routers');
    createCrud('/employee-benefits', 'employee_benefits');
    createCrud('/time-records', 'time_records');
    createCrud('/dhcp-billing-plans', 'dhcp_billing_plans');
    createCrud('/dhcp_clients', 'dhcp_clients');
    createCrud('/sales', 'sales_records');
    dbRouter.get('/panel-settings', async (req, res) => { /* ... (same as before) */ });
    dbRouter.get('/company-settings', async (req, res) => { /* ... (same as before) */ });
    dbRouter.post('/company-settings', async (req, res) => { /* ... (same as before) */ });
    dbRouter.post('/panel-settings', async (req, res) => { /* ... (same as before) */ });
    dbRouter.get('/notifications', async (req, res) => { /* ... (same as before) */ });
    dbRouter.post('/notifications', async (req, res) => { /* ... (same as before) */ });
    dbRouter.patch('/notifications/:id', async (req, res) => { /* ... (same as before) */ });
    dbRouter.post('/notifications/clear-all', async (req, res) => { /* ... (same as before) */ });
    dbRouter.post('/sales/clear-all', async (req, res) => { /* ... (same as before) */ });
    
    // Add router lookup for API backend
    dbRouter.get('/routers/:id', async (req, res) => {
        try {
            const router = await db.get('SELECT * FROM routers WHERE id = ?', req.params.id);
            if (router) {
                res.json(router);
            } else {
                res.status(404).json({ message: 'Router not found' });
            }
        } catch (e) {
            res.status(500).json({ message: e.message });
        }
    });

    app.use('/api/db', dbRouter);

    // --- MIKROTIK API (Unified and Protected) ---
    const mtApiRouter = express.Router();
    mtApiRouter.use(protect);

    const createRouterInstance = (config) => {
        if (!config || !config.host || !config.user) throw new Error('Invalid router configuration');
        if (config.api_type === 'legacy') {
            const isTls = config.port === 8729;
            return new RouterOSAPI({ host: config.host, user: config.user, password: config.password || '', port: config.port || 8728, timeout: 15, tls: isTls, tlsOptions: isTls ? { rejectUnauthorized: false, minVersion: 'TLSv1.2' } : undefined });
        }
        const protocol = config.port === 443 ? 'https' : 'http';
        const baseURL = `${protocol}://${config.host}:${config.port}/rest`;
        const auth = { username: config.user, password: config.password || '' };
        const instance = axios.create({ baseURL, auth, httpsAgent: new https.Agent({ rejectUnauthorized: false, minVersion: 'TLSv1.2' }), timeout: 15000 });
        instance.interceptors.response.use(response => {
            const mapId = (item) => (item && typeof item === 'object' && '.id' in item) ? { ...item, id: item['.id'] } : item;
            if (response.data && typeof response.data === 'object') {
                response.data = Array.isArray(response.data) ? response.data.map(mapId) : mapId(response.data);
            }
            return response;
        }, error => Promise.reject(error));
        return instance;
    };

    const getRouter = async (req, res, next) => {
        try {
            const { routerId } = req.params;
            if (!routerId) return res.status(400).json({ message: 'Router ID missing' });
            const routerConfig = await db.get('SELECT * FROM routers WHERE id = ?', [routerId]);
            if (!routerConfig) return res.status(404).json({ message: 'Router not found' });
            req.router = routerConfig;
            req.routerInstance = createRouterInstance(req.router);
            next();
        } catch (e) {
            console.error(`[API] Error in getRouter for ID ${req.params.routerId}:`, e.message);
            res.status(500).json({ message: 'Internal server error while getting router config.' });
        }
    };
    
    const writeLegacySafe = async (client, query) => {
        try { return await client.write(query); } catch (error) { if (error.errno === 'UNKNOWNREPLY' && error.message.includes('!empty')) { return []; } throw error; }
    };
    
    const normalizeLegacyObject = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const newObj = {};
        for (const key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key.replace(/_/g, '-')] = obj[key]; }
        if (newObj['.id']) newObj.id = newObj['.id'];
        return newObj;
    }
    
    // Test connection route is special (doesn't use getRouter)
    mtApiRouter.post('/test-connection', async (req, res) => {
        const config = req.body;
        try {
            if (!config || !config.host || !config.user || !config.api_type) return res.status(400).json({ success: false, message: 'Incomplete router configuration.' });
            const client = createRouterInstance(config);
            if (config.api_type === 'legacy') {
                await client.connect();
                await writeLegacySafe(client, ['/system/resource/print']);
                await client.close();
            } else {
                await client.get('/system/resource');
            }
            res.json({ success: true, message: 'Connection successful!' });
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            const msg = e.response?.data?.message || e.response?.data?.detail || e.message;
            res.status(status).json({ success: false, message: `Connection failed: ${msg}` });
        }
    });

    const routerSpecificRouter = express.Router({ mergeParams: true });
    routerSpecificRouter.use(getRouter);

    // Copy all other specific routes from api-backend...
    routerSpecificRouter.get('/interface/stats', async (req, res) => { /* ... logic from api-backend */ });
    routerSpecificRouter.post('/dhcp-client/update', async (req, res) => { /* ... logic from api-backend */ });
    routerSpecificRouter.get('/system/script/wan-failover-status', async (req, res) => { /* ... logic from api-backend */ });
    routerSpecificRouter.post('/system/script/configure-wan-failover', async (req, res) => { /* ... logic from api-backend */ });

    // Generic catch-all at the end
    routerSpecificRouter.all('/:endpoint(*)', async (req, res) => {
        const { endpoint } = req.params;
        const method = req.method;
        const body = req.body;
        try {
            if (req.router.api_type === 'legacy') {
                 const client = req.routerInstance;
                 await client.connect();
                 const cmd = '/' + endpoint; 
                 if (method === 'POST' && body) {
                      await client.write(cmd, body);
                      res.json({ message: 'Command executed' });
                 } else {
                      const data = await writeLegacySafe(client, [cmd]);
                      res.json(data.map(normalizeLegacyObject));
                 }
                 await client.close();
            } else {
                const instance = req.routerInstance;
                let finalEndpoint = endpoint;
                if (method === 'GET' && finalEndpoint.endsWith('/print')) {
                    finalEndpoint = finalEndpoint.replace(/\/print$/, '');
                }
                const response = await instance.request({ method, url: `/${finalEndpoint}`, data: body });
                res.json(response.data);
            }
        } catch (e) {
            console.error(`Proxy Error (${endpoint}):`, e.message);
            const status = e.response ? e.response.status : 500;
            const msg = e.response && e.response.data ? (e.response.data.message || e.response.data.detail) : e.message;
            res.status(status).json({ message: msg });
        }
    });

    mtApiRouter.use('/:routerId', routerSpecificRouter);
    app.use('/mt-api', mtApiRouter);
    
    // --- OTHER API ROUTES (License, Host Status, etc.) ---
    app.use('/api/license', protect, (() => {
        const router = express.Router();
        router.get('/status', async (req, res) => { /* ... logic ... */ });
        router.post('/activate', async (req, res) => { /* ... logic ... */ });
        router.post('/revoke', async (req, res) => { /* ... logic ... */ });
        router.post('/generate', requireSuperadmin, (req, res) => { /* ... logic ... */ });
        return router;
    })());
    app.get('/api/host-status', protect, async (req, res) => { /* ... logic ... */ });
    // ... all other non-DB, non-MikroTik APIs ...
    
    // --- STATIC FILE SERVING (PRODUCTION) ---
    const frontendDistPath = path.join(__dirname, '..', 'dist');

    if (fs.existsSync(frontendDistPath)) {
        app.use(express.static(frontendDistPath));

        // For any other GET request that doesn't match an API route or a static file,
        // serve the index.html file for client-side routing.
        app.get('*', (req, res) => {
            res.sendFile(path.join(frontendDistPath, 'index.html'));
        });
    } else {
        console.warn('WARNING: Frontend "dist" directory not found. UI will not be served.');
        console.warn('Please run "npm run build" in the root directory.');
    }

    // --- START SERVER AND WEBSOCKET ---
    const server = app.listen(PORT, () => {
        console.log(`✅ MikroTik Manager UI running on http://localhost:${PORT}`);
    });

    // WebSocket SSH Proxy Logic
    const wss = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        if (request.url === '/ws/ssh') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });

    wss.on('connection', (ws) => {
        const ssh = new Client();
        ws.on('message', (message) => {
            const msg = JSON.parse(message);
            if (msg.type === 'auth') {
                const { host, user, password, term_cols, term_rows } = msg.data;
                ssh.on('ready', () => {
                    ws.send('*** SSH Connection Established ***\r\n');
                    ssh.shell({ term: 'xterm-color', cols: term_cols, rows: term_rows }, (err, stream) => {
                        if (err) { ws.send(`*** SSH Shell Error: ${err.message} ***\r\n`); return; }
                        stream.on('data', (data) => ws.send(data.toString()));
                        stream.on('close', () => ssh.end());
                        ws.on('message', (data) => {
                            const innerMsg = JSON.parse(data);
                            if (innerMsg.type === 'data') stream.write(innerMsg.data);
                            else if (innerMsg.type === 'resize') stream.setWindow(innerMsg.rows, innerMsg.cols);
                        });
                    });
                }).on('error', (err) => {
                    ws.send(`*** SSH Connection Error: ${err.message} ***\r\n`);
                    ws.close();
                }).connect({ host, port: 22, username: user, password: password || '', readyTimeout: 20000 });
            }
        });
        ws.on('close', () => ssh.end());
    });
}

startServer();
