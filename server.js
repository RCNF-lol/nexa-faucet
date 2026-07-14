// backend/server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ✅ Security middleware
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ✅ Intentar usar libnexa-ts para formatNEXA, fallback a función local
let UnitUtils;
try {
    const libnexa = require('libnexa-ts');
    UnitUtils = libnexa.UnitUtils;
    console.log('✅ libnexa-ts loaded - using UnitUtils.formatNEXA');
} catch (err) {
    console.warn('⚠️ libnexa-ts not available - using fallback formatNEXA');
    UnitUtils = {
        formatNEXA: (satoshis) => (parseInt(satoshis, 10) / 100).toFixed(2)
    };
}

// ✅ Local imports - PostgreSQL + Sequelize version
const { getBalance, sendFaucet, getFaucetAddress } = require('./wallet');
const { 
    canRequest, 
    saveRequest, 
    sequelize,
    Request,
    initializeTables,
    getDbInfo,
    closeDatabase,
    usePostgreSQL
} = require('./database');

const app = express();

// ✅ FIX: Trust proxy para correcta detección de IP detrás de Render/Cloudflare
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════
// 🔍 VERIFICACIÓN CRÍTICA: ¿sequelize está definido?
// ═══════════════════════════════════════════════════════════
console.log('🔍 Debug database connection:', {
    sequelize: sequelize !== undefined ? '✅ DEFINED' : '❌ UNDEFINED',
    isConnected: sequelize?.authenticate ? '✅ Can authenticate' : '❌ No authenticate method',
    usePostgreSQL: usePostgreSQL !== undefined ? usePostgreSQL : '❌ NOT EXPORTED'
});

if (!sequelize) {
    console.error('❌ FATAL: sequelize is undefined! Revisa database.js exports');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════
// 🔐 SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════
// ✅ Helmet para headers HTTP seguros
app.use(helmet({
    contentSecurityPolicy: false,  // Desactivado para permitir Tailwind CDN
    crossOriginEmbedderPolicy: false
}));

// ✅ Rate limiting para endpoints sensibles
const faucetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutos
    max: 5,  // Máximo 5 requests por IP por ventana
    message: { success: false, error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'Too many authentication attempts.' }
});

// ═══════════════════════════════════════════════════════════
// 🔐 ADMIN AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════
function requireAdminAuth(req, res, next) {
    if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ DEBUG MODE: Auth bypassed for local development');
        return next();
    }
    
    const authHeader = req.headers.authorization;
    const expectedAuth = `Bearer ${process.env.API_SECRET}`;
    
    if (!authHeader || authHeader !== expectedAuth) {
        console.warn(`⚠️ Unauthorized admin access attempt from ${getClientIP(req)}`);
        return res.status(401).json({ 
            success: false, 
            error: 'Unauthorized. Admin token required.' 
        });
    }
    next();
}

// ═══════════════════════════════════════════════════════════
// 🔒 CORS CONFIGURATION
// ═══════════════════════════════════════════════════════════
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:5500',
        'http://127.0.0.1:10000',
        'https://rcnf.netlify.app/',
        'https://nexa-faucet-kub8.onrender.com'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════
// 📊 LOGGING MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${getClientIP(req)}`);
    next();
});

// ═══════════════════════════════════════════════════════════
// 🔐 UTILITIES
// ═══════════════════════════════════════════════════════════
function isValidNexaAddress(address) {
    if (!address || typeof address !== 'string') return false;
    if (UnitUtils?.validateAddress) {
        try { return UnitUtils.validateAddress(address); } catch {}
    }
    return /^nexa:[a-z0-9]{48,90}$/.test(address);
}

// ✅ FIX: Obtener IP real considerando proxies
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
        || req.headers['x-real-ip'] 
        || req.ip 
        || req.connection?.remoteAddress 
        || 'unknown';
}

// ═══════════════════════════════════════════════════════════
// 🚰 FAUCET ROUTES (con rate limiting)
// ═══════════════════════════════════════════════════════════
app.post('/faucet', faucetLimiter, async (req, res) => {
    const { address } = req.body;

    try {
        if (!address || typeof address !== 'string') {
            return res.status(400).json({ error: 'Address required' });
        }
        if (!isValidNexaAddress(address)) {
            return res.status(400).json({ error: 'Invalid Nexa address' });
        }

        const allowed = await canRequest(address);
        if (!allowed) {
            return res.status(429).json({ error: 'You have already claimed funds. Please wait 24 hours.' });
        }

        const balance = await getBalance();
        const amountSatoshis = parseInt(process.env.FAUCET_AMOUNT, 10) || 10000;
        const amountInNEXA = UnitUtils.formatNEXA(amountSatoshis);
        
        console.log(`💰 Faucet amount: ${amountSatoshis} satoshis = ${amountInNEXA} NEXA`);

        if (balance < amountSatoshis) {
            return res.status(500).json({ error: 'Faucet has insufficient funds.' });
        }

        let txid;
        try {
            txid = await sendFaucet(address, amountSatoshis);
            await saveRequest(address);
            console.log(`✅ Sent ${amountInNEXA} NEXA to ${address}. TXID: ${txid}`);

            res.json({
                success: true,
                txid,
                amount: amountSatoshis,
                amountInNEXA,
                message: `Sent ${amountInNEXA} NEXA to ${address}`
            });
        } catch (sendError) {
            console.error('❌ Error sending transaction:', sendError.message);
            res.status(500).json({ error: 'Failed to send transaction.' });
        }
    } catch (error) {
        console.error('❌ Error in faucet:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/balance', async (req, res) => {
    try {
        const balanceSatoshis = await getBalance();
        const balanceInNEXA = UnitUtils.formatNEXA(balanceSatoshis);
        res.json({
            success: true,
            balance: balanceSatoshis,
            balanceInNEXA,
            address: await getFaucetAddress()
        });
    } catch (error) {
        console.error('Error getting balance:', error);
        res.status(500).json({ error: 'Could not retrieve balance' });
    }
});

// ✅ FIX: /clear-cooldown ahora protegido con requireAdminAuth + authLimiter
app.post('/clear-cooldown', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        await Request.destroy({ truncate: true });
        console.log('🧹 All cooldowns cleared by admin');
        res.json({ success: true, message: 'Cooldowns cleared' });
    } catch (err) {
        console.error('❌ Error clearing cooldowns:', err.message);
        res.status(500).json({ error: 'Error clearing cooldowns: ' + err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// 🔍 HEALTH CHECK & DB INFO
// ═══════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
    try {
        await sequelize.authenticate();
        const dbInfo = await getDbInfo();
        
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development',
            database: {
                type: usePostgreSQL ? 'PostgreSQL' : 'SQLite',
                connected: true,
                host: sequelize.config.host,
                database: sequelize.config.database,
                ...dbInfo
            },
            render_info: process.env.RENDER ? 
                '✅ Running on Render with persistent PostgreSQL' : null
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            database: { connected: false, error: error.message }
        });
    }
});

app.get('/api/admin/db/info', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const dbInfo = await getDbInfo();
        
        res.json({
            success: true,
            database: dbInfo,
            filesystem: {
                is_ephemeral: !usePostgreSQL,
                note: usePostgreSQL 
                    ? '✅ Using persistent PostgreSQL - data survives restarts' 
                    : '⚠️ Using local SQLite - data stored in faucet_dev.db'
            }
        });
    } catch (error) {
        console.error('DB info error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ⛔ 404 HANDLER
// ═══════════════════════════════════════════════════════════
app.all('*', (req, res) => {
    console.warn(`⚠️ 404: Route not found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Route not found' });
});

// ═══════════════════════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Faucet Backend running on port ${PORT}`);
    console.log(`🗄️  Database: ${usePostgreSQL ? 'PostgreSQL' : 'SQLite'} @ ${sequelize.config?.host || 'localhost'}:${sequelize.config?.port || 'N/A'}/${sequelize.config?.database || 'faucet_dev.db'}`);
    console.log(`💰 Faucet amount: ${UnitUtils.formatNEXA(parseInt(process.env.FAUCET_AMOUNT, 10) || 10000)} NEXA`);
    
    // Debug: Listar rutas registradas
    console.log('🗺️ Registered routes preview:');
    app._router?.stack?.forEach((r) => {
        if (r.route?.path) {
            const method = Object.keys(r.route.methods)[0]?.toUpperCase();
            console.log(`  ${method} ${r.route.path}`);
        }
    });
    
    try {
        await initializeTables();
        console.log('✅ System initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing system:', error.message);
        process.exit(1);
    }
    console.log(`🔍 Health check: GET /api/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔄 Shutting down...');
    try { 
        await closeDatabase(); 
        console.log('✅ Database connection closed'); 
    } catch (err) { 
        console.error('❌ Error closing DB:', err.message); 
    }
    process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});