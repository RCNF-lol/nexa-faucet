require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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

// ✅ Local imports
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
app.set('trust proxy', 1);
const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════
// 🔍 VERIFICACIÓN CRÍTICA
// ═══════════════════════════════════════════════════════════
if (!sequelize) {
    console.error('❌ FATAL: sequelize is undefined! Revisa database.js exports');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════
// 🔐 SECURITY & CORS MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use(cors({
    origin: '*', // Permitir todas las origenes para pruebas (ajustar en producción si es necesario)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════
// ✅ SERVIR ARCHIVOS DEL FRONTEND (¡ESTO ARREGLA LOS ERRORES DE CSS/JS!)
// ═══════════════════════════════════════════════════════════
// Intenta servir desde la carpeta 'public' primero, si no, desde la raíz
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════
// 📊 LOGGING MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
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

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

// ═══════════════════════════════════════════════════════════
// 🚰 FAUCET ROUTES
// ═══════════════════════════════════════════════════════════
const faucetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, error: 'Too many requests. Please wait 15 minutes.' }
});

app.post('/faucet', faucetLimiter, async (req, res) => {
    const { address } = req.body;
    try {
        if (!address || !isValidNexaAddress(address)) {
            return res.status(400).json({ error: 'Invalid Nexa address' });
        }

        const allowed = await canRequest(address);
        if (!allowed) {
            return res.status(429).json({ error: 'You have already claimed funds. Please wait 24 hours.' });
        }

        const balance = await getBalance();
        const amountSatoshis = parseInt(process.env.FAUCET_AMOUNT, 10) || 10000;
        const amountInNEXA = UnitUtils.formatNEXA(amountSatoshis);
        
        if (balance < amountSatoshis) {
            return res.status(500).json({ error: 'Faucet has insufficient funds.' });
        }

        const txid = await sendFaucet(address, amountSatoshis);
        await saveRequest(address);
        console.log(`✅ Sent ${amountInNEXA} NEXA to ${address}. TXID: ${txid}`);

        res.json({
            success: true,
            txid,
            amount: amountSatoshis,
            amountInNEXA,
            message: `Sent ${amountInNEXA} NEXA to ${address}`
        });
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

// ═══════════════════════════════════════════════════════════
// ✅ RUTA /TRANSACTIONS (Para que el frontend no dé error 404)
// ═══════════════════════════════════════════════════════════
app.get('/transactions', async (req, res) => {
    try {
        // Por ahora devolvemos un array vacío. 
        // Aquí puedes conectar tu lógica de historial de base de datos después.
        res.json({ success: true, transactions: [] });
    } catch (error) {
        console.error('Error getting transactions:', error);
        res.status(500).json({ error: 'Could not retrieve transactions' });
    }
});

// ═══════════════════════════════════════════════════════════
// 🔍 HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
    try {
        await sequelize.authenticate();
        const dbInfo = await getDbInfo();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: {
                type: usePostgreSQL ? 'PostgreSQL' : 'SQLite',
                connected: true,
                ...dbInfo
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', database: { connected: false, error: error.message } });
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
    try {
        await initializeTables();
        console.log('✅ System initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing system:', error.message);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    await closeDatabase();
    process.exit(0);
});