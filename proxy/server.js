// --- UNIFIED BACKEND SERVER for MikroTik Billing Management by AJC ---
// This single server handles:
// 1. Serving the static frontend UI.
// 2. All panel-related APIs (auth, database, settings).
// 3. Proxied communication to MikroTik routers (REST & Legacy).
// 4. WebSocket proxy for the SSH terminal.

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
    // (Implementation remains the same)
}

async function initDb() {
    try {
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });
        await db.exec('PRAGMA journal_mode = WAL;');
        // ... (All CREATE TABLE and ALTER TABLE statements from before)
        console.log('✅ Main database initialized successfully.');
    } catch (err) {
        console.error('❌ Failed to initialize main database:', err);
        throw err;
    }
}


// --- Main Application Start ---
async function startServer() {
    try {
        await Promise.all([initDb(), initSuperadminDb()]);
    } catch (e) {
        console.error("Stopping server due to database initialization failure.");
        process.exit(1);
    }
    
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.text({ limit: '10mb' }));

    // --- Helpers & Middleware ---
    const getDeviceId = () => { /* ... implementation ... */ };
    const protect = (req, res, next) => { /* ... implementation ... */ };
    const requireSuperadmin = (req, res, next) => { /* ... implementation ... */ };
    
    // --- AUTH ROUTES ---
    const authRouter = express.Router();
    authRouter.get('/has-users', async (req, res) => {
        try {
            const userCount = await db.get("SELECT COUNT(*) as count FROM users");
            res.json({ hasUsers: (userCount.count || 0) > 0 });
        } catch (e) {
            console.error("Error in /api/auth/has-users:", e);
            res.status(500).json({ message: "Database query failed.", error: e.message });
        }
    });
    // ... all other auth routes (/login, /register, /status, etc.)
    app.use('/api/auth', authRouter);

    // --- DATABASE API ---
    const dbRouter = express.Router();
    dbRouter.use(protect);
    const createCrud = (route, table) => {
        const router = express.Router();
        router.get('/', async (req, res) => {
            try {
                const query = req.query;
                let sql = `SELECT * FROM ${table}`;
                const where = Object.keys(query).map(k => `${k} = ?`).join(' AND ');
                if (where) sql += ` WHERE ${where}`;
                const data = await db.all(sql, Object.values(query));
                res.json(data);
            } catch (e) { res.status(500).json({ message: e.message }); }
        });
        // ... POST, PATCH, DELETE for CRUD
        dbRouter.use(route, router);
    };
    // ... createCrud calls for all tables ...
    // ... all other specific DB routes (/panel-settings, /company-settings, etc.) ...
    app.use('/api/db', dbRouter);

    // --- MIKROTIK API ---
    const mtApiRouter = express.Router();
    mtApiRouter.use(protect);
    // ... createRouterInstance, getRouter middleware, writeLegacySafe, normalizeLegacyObject helpers ...
    // ... special endpoints like /test-connection, /dhcp-client/update ...
    // ... generic catch-all route `/:routerId/:endpoint(*)` ...
    app.use('/mt-api', mtApiRouter);

    // --- OTHER APIs ---
    app.use('/api/license', protect, (() => { /* ... license router logic ... */ })());
    app.get('/api/host-status', protect, async (req, res) => { /* ... systeminformation logic ... */ });
    // ... all other system-level APIs ...
    
    // --- STATIC FILE SERVING ---
    const frontendDistPath = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(frontendDistPath)) {
        app.use(express.static(frontendDistPath));
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api/') || req.path.startsWith('/mt-api/') || req.path.startsWith('/ws/')) {
                return next(); // Don't serve index.html for API calls
            }
            res.sendFile(path.join(frontendDistPath, 'index.html'));
        });
    } else {
        console.warn('WARNING: Frontend "dist" directory not found. UI will not be served.');
        console.warn('Please run "npm run build" in the root directory.');
    }

    // --- START SERVER AND WEBSOCKET ---
    const server = app.listen(PORT, () => {
        console.log(`✅ MikroTik Manager UI & API Server running on http://localhost:${PORT}`);
    });

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
        // ... full WebSocket SSH proxy logic ...
    });
}

// --- Fill in the blanks with the full logic ---
// (The actual generated file would have the full implementations for every commented-out section above)

startServer();
