const express = require('express');
const cors = require('cors');
const { RouterOSAPI } = require('node-routeros-v2');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// Helper to create router instance based on config
const createRouterInstance = (config) => {
    if (!config || !config.host || !config.user) {
        throw new Error('Invalid router configuration');
    }
    
    if (config.api_type === 'legacy') {
        const isTls = config.port === 8729;
        return new RouterOSAPI({
            host: config.host,
            user: config.user,
            password: config.password || '',
            port: config.port || 8728,
            timeout: 15,
            tls: isTls,
            tlsOptions: isTls ? { rejectUnauthorized: false, minVersion: 'TLSv1.2' } : undefined,
        });
    }

    const protocol = config.port === 443 ? 'https' : 'http';
    const baseURL = `${protocol}://${config.host}:${config.port}/rest`;
    const auth = { username: config.user, password: config.password || '' };

    const instance = axios.create({ 
        baseURL, 
        auth,
        httpsAgent: new https.Agent({ rejectUnauthorized: false, minVersion: 'TLSv1.2' }),
        timeout: 15000
    });

    // Normalize ID fields
    instance.interceptors.response.use(response => {
        const mapId = (item) => {
            if (item && typeof item === 'object' && '.id' in item) {
                return { ...item, id: item['.id'] };
            }
            return item;
        };

        if (response.data && typeof response.data === 'object') {
            if (Array.isArray(response.data)) {
                response.data = response.data.map(mapId);
            } else {
                response.data = mapId(response.data);
            }
        }
        return response;
    }, error => Promise.reject(error));

    return instance;
};

// Middleware to attach router config based on ID by calling the proxy server
const getRouter = async (req, res, next) => {
    try {
        const routerId = req.params.routerId;
        if (!routerId) {
            return res.status(400).json({ message: 'Router ID missing' });
        }
        
        const proxyUrl = 'http://localhost:3001'; 
        const response = await axios.get(`${proxyUrl}/api/db/routers/${routerId}`, {
            headers: {
                'Authorization': req.headers.authorization
            }
        });
        
        const routerConfig = response.data;
        if (!routerConfig) {
             console.warn(`[Backend] Router ID ${routerId} not found via proxy.`);
             return res.status(404).json({ message: 'Router not found' });
        }
        
        req.router = routerConfig;
        req.routerInstance = createRouterInstance(req.router);
        next();
    } catch (e) {
        console.error(`[Backend] Error fetching router config from proxy for ID ${req.params.routerId}:`, e.message);
        if (e.response) {
            return res.status(e.response.status).json({ message: e.response.data.message || 'Router not found' });
        }
        res.status(500).json({ message: 'Internal Server Error: Could not communicate with main panel service.' });
    }
};


// Helper for Legacy Writes
const writeLegacySafe = async (client, query) => {
    try {
        return await client.write(query);
    } catch (error) {
        if (error.errno === 'UNKNOWNREPLY' && error.message.includes('!empty')) {
            return [];
        }
        throw error;
    }
};

const normalizeLegacyObject = (obj) => {
     if (!obj || typeof obj !== 'object') return obj;
    const newObj = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            newObj[key.replace(/_/g, '-')] = obj[key];
        }
    }
    if (newObj['.id']) newObj.id = newObj['.id'];
    return newObj;
}

// --- SPECIAL ENDPOINTS (must come before the generic proxy) ---

app.post('/test/test-connection', async (req, res) => {
    const config = req.body;
    try {
        if (!config || !config.host || !config.user || !config.api_type) {
            return res.status(400).json({ success: false, message: 'Incomplete router configuration provided for testing.' });
        }
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
        console.error("Test Connection Error:", e.message);
        const status = e.response ? e.response.status : 500;
        const msg = e.response?.data?.message || e.response?.data?.detail || e.message;
        res.status(status).json({ success: false, message: `Connection failed: ${msg}` });
    }
});

app.get('/:routerId/interface/stats', getRouter, async (req, res) => {
    try {
        if (req.router.api_type === 'legacy') {
            const client = req.routerInstance;
            await client.connect();
            try {
                const result = await writeLegacySafe(client, ['/interface/print', 'stats', 'detail', 'without-paging']);
                res.json(result.map(normalizeLegacyObject));
            } finally {
                await client.close();
            }
        } else {
            const response = await req.routerInstance.post('/interface/print', { 'stats': true, 'detail': true });
            res.json(response.data);
        }
    } catch (e) {
        console.error("Stats Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

app.post('/:routerId/dhcp-client/update', getRouter, async (req, res) => {
    const { 
        macAddress, address, customerInfo, 
        plan, downtimeDays, planType, graceDays, graceTime, 
        expiresAt: manualExpiresAt, contactNumber, email, speedLimit 
    } = req.body;
    try {
        let expiresAt;
        if (manualExpiresAt) {
            expiresAt = new Date(manualExpiresAt);
        } else if (graceDays) {
            const now = new Date();
            if (graceTime) {
                const [hours, minutes] = graceTime.split(':').map(Number);
                now.setHours(hours, minutes, 0, 0);
            }
            expiresAt = new Date(now.getTime() + (graceDays * 24 * 60 * 60 * 1000));
        } else if (plan && plan.cycle_days) {
            const now = new Date();
            expiresAt = new Date(now.getTime() + (plan.cycle_days * 24 * 60 * 60 * 1000));
        } else {
            expiresAt = new Date(); 
        }
        const commentData = {
            customerInfo,
            contactNumber,
            email,
            planName: plan ? plan.name : '',
            dueDate: expiresAt.toISOString().split('T')[0],
            dueDateTime: expiresAt.toISOString(),
            planType: planType || 'prepaid'
        };
        const schedName = `deactivate-dhcp-${address.replace(/\./g, '-')}`;
        const onEvent = `/ip firewall address-list remove [find where address="${address}" and list="authorized-dhcp-users"]; /ip firewall connection remove [find where src-address~"^${address}"]; :local leaseId [/ip dhcp-server lease find where address="${address}"]; if ([:len $leaseId] > 0) do={ /ip firewall address-list add address="${address}" list="pending-dhcp-users" timeout=1d comment="${macAddress}"; }`;
        const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const rosDate = `${months[expiresAt.getMonth()]}/${String(expiresAt.getDate()).padStart(2,'0')}/${expiresAt.getFullYear()}`;
        const rosTime = expiresAt.toTimeString().split(' ')[0];
        if (req.router.api_type === 'legacy') {
            const client = req.routerInstance;
            await client.connect();
            const addressLists = await writeLegacySafe(client, ['/ip/firewall/address-list/print', '?address=' + address, '?list=authorized-dhcp-users']);
            if (addressLists.length > 0) {
                await client.write('/ip/firewall/address-list/set', {
                    '.id': addressLists[0]['.id'],
                    comment: JSON.stringify(commentData)
                });
            }
            if (speedLimit) {
                const limitString = `${speedLimit}M/${speedLimit}M`;
                const queues = await writeLegacySafe(client, ['/queue/simple/print', '?name=' + customerInfo]);
                if (queues.length > 0) {
                    await client.write('/queue/simple/set', {
                        '.id': queues[0]['.id'],
                        'max-limit': limitString
                    });
                } else {
                    await client.write('/queue/simple/add', {
                        name: customerInfo,
                        target: address,
                        'max-limit': limitString
                    });
                }
            }
            const scheds = await writeLegacySafe(client, ['/system/scheduler/print', '?name=' + schedName]);
            if (scheds.length > 0) {
                await client.write('/system/scheduler/remove', { '.id': scheds[0]['.id'] });
            }
            await client.write('/system/scheduler/add', {
                name: schedName,
                'start-date': rosDate,
                'start-time': rosTime,
                interval: '0s',
                'on-event': onEvent
            });
            await client.close();
        } else {
            const instance = req.routerInstance;
            try {
                const alRes = await instance.get(`/ip/firewall/address-list?address=${address}&list=authorized-dhcp-users`);
                if (alRes.data && alRes.data.length > 0) {
                    await instance.patch(`/ip/firewall/address-list/${alRes.data[0]['.id']}`, {
                        comment: JSON.stringify(commentData)
                    });
                }
            } catch (e) { console.warn("Address list update warning", e.message); }
            if (speedLimit) {
                 const limitString = `${speedLimit}M/${speedLimit}M`;
                 try {
                    const qRes = await instance.get(`/queue/simple?name=${customerInfo}`);
                    if (qRes.data && qRes.data.length > 0) {
                        await instance.patch(`/queue/simple/${qRes.data[0]['.id']}`, { 'max-limit': limitString });
                    } else {
                        await instance.put(`/queue/simple`, {
                           name: customerInfo,
                           target: address,
                           'max-limit': limitString
                        });
                    }
                 } catch (e) { console.error("Queue update error", e.message); }
            }
            try {
                const sRes = await instance.get(`/system/scheduler?name=${schedName}`);
                if (sRes.data && sRes.data.length > 0) {
                    await instance.delete(`/system/scheduler/${sRes.data[0]['.id']}`);
                }
                
                await instance.put(`/system/scheduler`, {
                    name: schedName,
                    'start-date': rosDate,
                    'start-time': rosTime,
                    interval: '0s',
                    'on-event': onEvent
                });
            } catch (e) { console.error("Scheduler update error", e.message); }
        }
        res.json({ message: 'Updated successfully' });
    } catch (e) {
        console.error("Update Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

app.get('/:routerId/system/script/wan-failover-status', getRouter, async (req, res) => {
    try {
        let routes;
        if (req.router.api_type === 'legacy') {
            const client = req.routerInstance;
            await client.connect();
            routes = await writeLegacySafe(client, ['/ip/route/print', '?check-gateway']);
            await client.close();
        } else {
            const response = await req.routerInstance.get('/ip/route');
            routes = response.data;
        }
        const monitoredRoutes = routes.filter(r => r['check-gateway']);
        if (monitoredRoutes.length === 0) {
            return res.json({ enabled: false, message: 'No routes with check-gateway found.' });
        }
        const isEnabled = monitoredRoutes.some(r => r.disabled === 'false' || !r.disabled);
        res.json({ enabled: isEnabled });
    } catch (e) {
        console.error("WAN Failover Status Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

app.post('/:routerId/system/script/configure-wan-failover', getRouter, async (req, res) => {
    const { enabled } = req.body;
    try {
        let routesToModify;
        if (req.router.api_type === 'legacy') {
            const client = req.routerInstance;
            await client.connect();
            const routes = await writeLegacySafe(client, ['/ip/route/print', '?check-gateway']);
            routesToModify = routes.filter(r => r['check-gateway']);
            for (const route of routesToModify) {
                await client.write('/ip/route/set', {
                    '.id': route['.id'],
                    'disabled': enabled ? 'no' : 'yes'
                });
            }
            await client.close();
        } else {
            const response = await req.routerInstance.get('/ip/route');
            routesToModify = response.data.filter(r => r['check-gateway']);
            for (const route of routesToModify) {
                await req.routerInstance.patch(`/ip/route/${route['.id']}`, {
                    disabled: !enabled
                });
            }
        }
        res.json({ message: `Failover routes ${enabled ? 'enabled' : 'disabled'}` });
    } catch (e) {
        console.error("Configure WAN Failover Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

app.all('/:routerId/:endpoint(*)', getRouter, async (req, res) => {
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
            const response = await instance.request({
                method: method,
                url: `/${finalEndpoint}`,
                data: body
            });
            res.json(response.data);
        }
    } catch (e) {
        console.error(`Proxy Error (${endpoint}):`, e.message);
        const status = e.response ? e.response.status : 500;
        const msg = e.response && e.response.data ? (e.response.data.message || e.response.data.detail) : e.message;
        res.status(status).json({ message: msg });
    }
});

app.listen(PORT, () => {
    console.log(`MikroTik API Backend listening on port ${PORT}`);
});
