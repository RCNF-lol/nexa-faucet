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
// ═══════════════════════════════════════════════════════════
// ✅ FIX: Importar TODAS las funciones necesarias incluyendo WinnerVideo
// ═══════════════════════════════════════════════════════════
const { getBalance, sendFaucet, getFaucetAddress } = require('./wallet');
const { 
    canRequest, 
    saveRequest, 
    sequelize,
    Request,
    RaffleParticipant,
    WinnerVideo,  // ✅ NUEVO: Modelo para videos
    resetRaffle,
    getAllParticipants,
    getRaffleStats,
    selectRandomWinner,
    markWinnerNotified,
    exportParticipantsToCSV,
    deleteParticipant,
    searchParticipants,
    initializeTables,
    syncWinnerVideoTable,  // ✅ NUEVO: Sync para tabla de videos
    getDbInfo,
    closeDatabase,
    Op,
    usePostgreSQL,
    // ✅ NUEVO: Funciones CRUD para WinnerVideo
    createWinnerVideo,
    getWinnerVideos,
    getWinnerVideoById,
    getWinnerVideoByParticipant,
    deleteWinnerVideo,
    updateWinnerVideo
} = require('./database');
const { sendConfirmationEmail, getTransporter, isEmailConfigured } = require('./utils/email');

const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET;
const app = express();

// ✅ FIX: Trust proxy para correcta detección de IP detrás de Render/Cloudflare
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════
// 🎬 CLOUDINARY CONFIG (para almacenamiento de videos)
// ═══════════════════════════════════════════════════════════
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const multer = require('multer');

// Configurar Cloudinary (solo si hay credenciales)
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true
    });
    console.log('✅ Cloudinary configured for video storage');
} else {
    console.warn('⚠️ Cloudinary not configured - videos will not be uploaded. Add CLOUDINARY_* env vars.');
}

// Configurar Multer para uploads en memoria (Render no tiene FS persistente)
const storage = multer.memoryStorage();
const videoUpload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB máximo
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only MP4, WebM, MOV, MKV allowed.'), false);
        }
    }
});

// ═══════════════════════════════════════════════════════════
// 🎯 VARIABLE GLOBAL PARA FECHA DE SORTEO
// ═══════════════════════════════════════════════════════════
let raffleEndDateOverride = null;

function getRaffleEndDate() {
    return raffleEndDateOverride || process.env.RAFFLE_END_DATE || '2026-04-30T23:59:59Z';
}

function updateRaffleEndDate(newDateISO) {
    raffleEndDateOverride = newDateISO;
    console.log(`📅 Raffle end date updated in memory: ${newDateISO}`);
}

// ═══════════════════════════════════════════════════════════
// 🔍 VERIFICACIÓN CRÍTICA: ¿sequelize está definido?
// ═══════════════════════════════════════════════════════════
console.log('🔍 Debug database connection:', {
    sequelize: sequelize !== undefined ? '✅ DEFINED' : '❌ UNDEFINED',
    isConnected: sequelize?.authenticate ? '✅ Can authenticate' : '❌ No authenticate method',
    usePostgreSQL: usePostgreSQL !== undefined ? usePostgreSQL : '❌ NOT EXPORTED',
    WinnerVideo: WinnerVideo !== undefined ? '✅ MODEL EXPORTED' : '❌ MODEL MISSING'
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
        'https://devicegridtest.org',
        'https://www.devicegridtest.org',
        'https://devicegridtest.onrender.com'
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

function validateFFUID(uid) { return /^\d{8,12}$/.test(uid); }
function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePlayerName(name) { return /^[a-zA-Z0-9_ ]{3,20}$/.test(name); }

// ✅ FIX: Obtener IP real considerando proxies
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
        || req.headers['x-real-ip'] 
        || req.ip 
        || req.connection?.remoteAddress 
        || 'unknown';
}

function generateFingerprint(uid, email, ip) {
    const secret = process.env.API_SECRET || 'dev-fallback-secret';
    const data = `${uid.toLowerCase()}:${email.toLowerCase()}:${ip || ''}:${secret}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ═══════════════════════════════════════════════════════════
// 📡 RECAPTCHA ENDPOINT
// ═══════════════════════════════════════════════════════════
app.get('/api/recaptcha-key', (req, res) => {
    const siteKey = process.env.RECAPTCHA_SITE_KEY;
    if (!siteKey) {
        console.warn('⚠️ RECAPTCHA_SITE_KEY missing in .env');
        return res.status(500).json({ error: 'RECAPTCHA_SITE_KEY not configured' });
    }
    res.json({ siteKey });
});

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
// 🎁 PUBLIC RAFFLE ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/raffle/stats', async (req, res) => {
    try {
        const endDate = getRaffleEndDate();
        const now = new Date();
        const end = new Date(endDate);
        const isActive = now < end;
        
        const totalParticipants = await RaffleParticipant.count();
        const timeRemaining = isActive ? Math.max(0, end.getTime() - now.getTime()) : 0;
        const probability = totalParticipants > 0 ? (1 / totalParticipants * 100).toFixed(4) : '0.0000';
        
        const winnerCount = await RaffleParticipant.count({ where: { is_winner: true } });
        const hasWinner = winnerCount > 0;
        
        res.json({
            success: true,
            active: isActive && !hasWinner,
            hasWinner: hasWinner,
            raffle: {
                name: 'Free Fire Elite Pass',
                description: 'Win an Elite Pass valid for 30 days',
                end_date: endDate,
                prize: 'Elite Pass - 30 days of exclusive benefits',
                status: hasWinner ? 'completed' : (isActive ? 'active' : 'ended')
            },
            stats: {
                total_participants: totalParticipants,
                time_remaining: timeRemaining,
                probability: hasWinner ? '0%' : (probability + '%')
            }
        });
    } catch (error) {
        console.error('Stats error:', error.message);
        res.status(500).json({ success: false, error: 'Internal error: ' + error.message });
    }
});

app.get('/api/raffle/participants/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 10;
        const rows = await RaffleParticipant.findAll({
            attributes: ['player_name', 'created_at'],
            order: [['created_at', 'DESC']],
            limit: limit
        });
        const participants = rows.map(row => {
            const name = row.player_name;
            const masked = name.length > 6 
                ? name.substring(0, 3) + '***' + name.slice(-2)
                : name + '***';
            return { player_name: masked, registered_at: row.created_at };
        });
        res.json({ success: true, count: participants.length, participants });
    } catch (error) {
        console.error('Participants error:', error.message);
        res.status(500).json({ success: false, error: 'Internal error: ' + error.message });
    }
});

app.post('/api/raffle/register', async (req, res) => {
    const { ff_uid, player_name, email, fingerprint: providedFingerprint } = req.body;
    const ipAddress = getClientIP(req);
    
    if (!ff_uid || !validateFFUID(ff_uid)) {
        return res.status(400).json({ success: false, error: 'Invalid UID. Must be 8-12 digits.' });
    }
    if (!player_name || !validatePlayerName(player_name)) {
        return res.status(400).json({ success: false, error: 'Invalid name. Use 3-20 alphanumeric characters.' });
    }
    if (!email || !validateEmail(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email.' });
    }
    
    const sanitizedEmail = email.toLowerCase().trim();
    const sanitizedName = player_name.trim();
    const fp = providedFingerprint || generateFingerprint(ff_uid, sanitizedEmail, ipAddress);
    const endDate = getRaffleEndDate();
    
    const now = new Date();
    const isTimeActive = now < new Date(endDate);
    
    const existingWinner = await RaffleParticipant.findOne({ 
        where: { is_winner: true },
        attributes: ['id']
    });
    const hasWinner = !!existingWinner;
    
    if (!isTimeActive || hasWinner) {
        return res.status(403).json({ 
            success: false, 
            error: hasWinner ? 'A winner has already been selected.' : 'Giveaway has ended.' 
        });
    }
    
    try {
        const existing = await RaffleParticipant.findOne({
            where: {
                [Op.or]: [
                    { ff_uid },
                    { email: sanitizedEmail },
                    { fingerprint: fp }
                ]
            },
            attributes: ['id']
        });
        
        if (existing) {
            return res.status(409).json({ 
                success: false, 
                error: 'This UID or email is already registered in the draw.' 
            });
        }
        
        const newParticipant = await RaffleParticipant.create({
            ff_uid,
            player_name: sanitizedName,
            email: sanitizedEmail,
            fingerprint: fp,
            ip_address: ipAddress
        });
        
        console.log(`✅ New participant: ${sanitizedName} (UID: ${ff_uid}) - DB ID: ${newParticipant.id}`);
        
        // 📧 ENVIAR EMAIL DE CONFIRMACIÓN (CON LOGGING MEJORADO - IIFE)
        console.log(`📧 Queuing confirmation email for: ${sanitizedEmail}`);
        
        (async () => {
            try {
                const emailResult = await Promise.race([
                    sendConfirmationEmail(sanitizedEmail, {
                        playerName: sanitizedName,
                        uid: ff_uid,
                        date: new Date().toLocaleString('en-US', { 
                            day: '2-digit', 
                            month: 'short', 
                            year: 'numeric', 
                            hour: '2-digit', 
                            minute: '2-digit' 
                        })
                    }),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Email timeout')), 30000)
                    )
                ]);
                
                if (emailResult === true) {
                    console.log(`✅ Confirmation email SENT to ${sanitizedEmail}`);
                } else if (emailResult === false) {
                    console.warn(`⚠️ Confirmation email FAILED for ${sanitizedEmail}`);
                }
            } catch (emailError) {
                console.error(`❌ Email promise REJECTED for ${sanitizedEmail}:`, {
                    message: emailError.message,
                    code: emailError.code
                });
            }
        })();
        
        // 🔧 DEBUG: Parámetro ?testEmail=usuario@gmail.com para probar email
        if (req.query.testEmail) {
            console.log(`🧪 Debug: testEmail query param detected: ${req.query.testEmail}`);
            (async () => {
                try {
                    const result = await sendConfirmationEmail(req.query.testEmail, {
                        playerName: 'Debug Test',
                        uid: '0000000000',
                        date: new Date().toLocaleString('es-ES')
                    });
                    console.log(`📧 Debug email result: ${result ? '✅ SENT' : '❌ FAILED'}`);
                } catch (e) {
                    console.error(`❌ Debug email error: ${e.message}`);
                }
            })();
        }
        
        res.json({
            success: true,
            message: 'Participation successfully registered!',
            participant: {
                id: newParticipant.id,
                player_name: sanitizedName,
                masked_uid: ff_uid.slice(0, 4) + '****' + ff_uid.slice(-4),
                registered_at: newParticipant.created_at
            }
        });
        
    } catch (err) {
        console.error('Error inserting participant:', err.message);
        if (err.name === 'SequelizeUniqueConstraintError' || err.message.includes('unique constraint')) {
            return res.status(409).json({ success: false, error: 'You have already participated with this data.' });
        }
        return res.status(500).json({ success: false, error: 'Registration error: ' + err.message });
    }
});

app.get('/api/raffle/winners', async (req, res) => {
    try {
        const rows = await RaffleParticipant.findAll({
            attributes: ['player_name', 'ff_uid', 'created_at', 'updated_at'],
            where: { is_winner: true },
            order: [['updated_at', 'DESC']],
            limit: 10
        });
        const winners = rows.map(w => ({
            player_name: w.player_name,
            masked_uid: '****' + w.ff_uid.slice(-4),
            date: w.updated_at || w.created_at
        }));
        res.json({ success: true, count: winners.length, winners });
    } catch (err) {
        console.error('Error fetching winners:', err.message);
        res.status(500).json({ success: false, error: 'Error loading winners: ' + err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// 🎛️ ADMIN ROUTES (PROTECTED)
// ═══════════════════════════════════════════════════════════
app.get('/api/admin/auth/verify', requireAdminAuth, authLimiter, (req, res) => {
    res.json({ success: true, authenticated: true, admin: { ip: getClientIP(req), timestamp: new Date().toISOString() } });
});

app.get('/api/admin/raffle/dashboard', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const [stats, participants] = await Promise.all([
            getRaffleStats(),
            getAllParticipants(false)
        ]);
        const now = new Date();
        const endDate = new Date(getRaffleEndDate());
        const isActive = now < endDate;
        
        const winnerCount = await RaffleParticipant.count({ where: { is_winner: true } });
        const hasWinner = winnerCount > 0;
        
        res.json({
            success: true,
            raffle: {
                name: 'Free Fire Elite Pass',
                status: hasWinner ? 'completed' : (isActive ? 'active' : 'ended'),
                end_date: getRaffleEndDate(),
                time_remaining: (isActive && !hasWinner) ? endDate.getTime() - now.getTime() : 0,
                hasWinner: hasWinner
            },
            stats: {
                total_participants: stats.total || 0,
                winners: stats.winners || 0,
                notified: stats.notified || 0,
                first_registration: stats.first_registration,
                last_registration: stats.last_registration,
                probability: hasWinner ? '0%' : (stats.total > 0 ? (1 / stats.total * 100).toFixed(4) + '%' : '0%')
            },
            recent_participants: participants.slice(0, 10)
        });
    } catch (error) {
        console.error('Dashboard error:', error.message);
        res.status(500).json({ success: false, error: 'Error loading dashboard: ' + error.message });
    }
});

app.get('/api/admin/raffle/participants', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const includeSensitive = req.query.sensitive === 'true';
        const participants = await getAllParticipants(includeSensitive);
        res.json({ success: true, count: participants.length, participants });
    } catch (error) {
        console.error('Participants list error:', error.message);
        res.status(500).json({ success: false, error: 'Error loading participants: ' + error.message });
    }
});

app.get('/api/admin/raffle/participants/search', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const query = req.query.q?.trim();
        if (!query || query.length < 2) {
            return res.json({ success: true, count: 0, participants: [] });
        }
        const sanitizedQuery = query.replace(/[%_\\]/g, '\\$&');
        const results = await searchParticipants(sanitizedQuery);
        res.json({ success: true, query, count: results.length, participants: results });
    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({ success: false, error: 'Search failed: ' + error.message });
    }
});

app.post('/api/admin/raffle/draw-winner', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const existingWinner = await RaffleParticipant.findOne({ 
            where: { is_winner: true },
            attributes: ['id']
        });
        if (existingWinner) {
            return res.status(400).json({ success: false, error: 'A winner has already been selected.' });
        }
        
        const participants = await getAllParticipants(true);
        if (participants.length === 0) {
            return res.status(400).json({ success: false, error: 'No entrants to select winner' });
        }
        
        const winner = await selectRandomWinner();
        if (!winner) {
            return res.status(400).json({ success: false, error: 'All entrants already selected as winners' });
        }
        
        const participantIds = participants.map(p => p.id).sort();
        const selectionHash = crypto.createHash('sha256').update(JSON.stringify({
            participants: participantIds,
            winner_id: winner.id,
            winner_index: winner.selection_index,
            timestamp: winner.selected_at,
            admin_ip: getClientIP(req)
        })).digest('hex');
        
        console.log(`🏆 Winner selected: ${winner.player_name} (Hash: ${selectionHash.substring(0, 16)}...)`);
        
        res.json({
            success: true,
            message: 'Winner successfully selected',
            winner: {
                id: winner.id,
                player_name: winner.player_name,
                ff_uid: winner.ff_uid,
                email: winner.email,
                selected_at: winner.selected_at
            },
            audit: {
                total_participants: winner.total_participants,
                selection_index: winner.selection_index,
                selection_hash: selectionHash,
                timestamp: new Date().toISOString(),
                admin_ip: getClientIP(req)
            }
        });
    } catch (error) {
        console.error('Draw winner error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to select winner: ' + error.message });
    }
});

app.post('/api/admin/raffle/participants/:id/notify', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const participantId = parseInt(req.params.id, 10);
        if (isNaN(participantId)) {
            return res.status(400).json({ success: false, error: 'Invalid ID' });
        }
        await markWinnerNotified(participantId);
        res.json({ success: true, message: 'Winner marked as notified', participant_id: participantId });
    } catch (error) {
        console.error('Notify winner error:', error.message);
        res.status(500).json({ success: false, error: 'Error updating status: ' + error.message });
    }
});

app.get('/api/admin/raffle/export/csv', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const csv = await exportParticipantsToCSV();
        const filename = `raffle_participants_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        console.error('Export CSV error:', error.message);
        res.status(500).json({ success: false, error: 'Error exporting: ' + error.message });
    }
});

app.delete('/api/admin/raffle/participants/:id', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const participantId = parseInt(req.params.id, 10);
        if (isNaN(participantId)) {
            return res.status(400).json({ success: false, error: 'Invalid ID' });
        }
        const deleted = await deleteParticipant(participantId);
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Participant not found' });
        }
        console.log(`🗑️ Participant deleted: ID ${participantId} by admin ${getClientIP(req)}`);
        res.json({ success: true, message: 'Participant deleted', participant_id: participantId });
    } catch (error) {
        console.error('Delete participant error:', error.message);
        res.status(500).json({ success: false, error: 'Error deleting participant: ' + error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// 🗑️ RESET RAFFLE
// ═══════════════════════════════════════════════════════════
app.post('/api/admin/raffle/reset', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const { confirm } = req.body;
        if (confirm !== 'RESET_RAFFLE_CONFIRM') {
            return res.status(400).json({ success: false, error: 'Explicit confirmation required' });
        }
        
        const resetResult = await resetRaffle();
        const deletedCount = typeof resetResult === 'object' && resetResult.deleted !== undefined 
            ? resetResult.deleted : (resetResult === true ? 'unknown' : 0);
        
        if (resetResult.new_end_date) {
            updateRaffleEndDate(resetResult.new_end_date);
        }
        
        console.log(`⚠️ RAFFLE RESET by admin ${getClientIP(req)} - Deleted ${deletedCount} participants`);
        
        res.json({
            success: true,
            message: 'Raffle reset successfully. All entrants have been deleted.',
            deleted: deletedCount,
            new_end_date: resetResult.new_end_date,
            config_updated: true
        });
        
    } catch (error) {
        console.error('Reset raffle error:', error.message);
        res.status(500).json({ success: false, error: 'Error resetting raffle: ' + error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ⚙️ UPDATE RAFFLE CONFIG
// ═══════════════════════════════════════════════════════════
app.put('/api/admin/raffle/config', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const { endDate, prizeDescription, isActive } = req.body;
        
        if (endDate) {
            const parsedDate = new Date(endDate);
            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Fecha inválida. Usa formato ISO 8601 (ej: 2026-05-15T23:59:59Z)' 
                });
            }
            raffleEndDateOverride = endDate;
            console.log(`📅 Raffle end date updated to: ${endDate}`);
        }
        
        if (prizeDescription && typeof prizeDescription === 'string' && prizeDescription.trim()) {
            process.env.RAFFLE_PRIZE_DESC = prizeDescription.trim();
            console.log(`🎁 Prize description updated: ${prizeDescription}`);
        }
        
        if (typeof isActive === 'boolean') {
            process.env.RAFFLE_FORCE_ACTIVE = isActive.toString();
            console.log(`🎛️ Raffle force active: ${isActive}`);
        }
        
        const now = new Date();
        const currentEndDate = getRaffleEndDate();
        const endDateObj = new Date(currentEndDate);
        
        const existingWinner = await RaffleParticipant.findOne({ 
            where: { is_winner: true },
            attributes: ['id']
        });
        const hasWinner = !!existingWinner;
        const isTimeActive = now < endDateObj;
        const forceActive = process.env.RAFFLE_FORCE_ACTIVE === 'true';
        const isActiveState = (isTimeActive || forceActive) && !hasWinner;
        
        res.json({
            success: true,
            message: 'Configuración del sorteo actualizada',
            config: {
                end_date: currentEndDate,
                prize_description: process.env.RAFFLE_PRIZE_DESC || 'Elite Pass - 30 days of exclusive benefits',
                is_active: isActiveState,
                has_winner: hasWinner,
                time_remaining: isActiveState ? Math.max(0, endDateObj.getTime() - now.getTime()) : 0,
                force_active: forceActive
            }
        });
        
    } catch (error) {
        console.error('❌ Error updating raffle config:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Error updating configuration: ' + error.message 
        });
    }
});

// ═══════════════════════════════════════════════════════════
// 📧 EMAIL ENDPOINTS
// ═══════════════════════════════════════════════════════════
app.post('/api/admin/email/test-send', requireAdminAuth, authLimiter, async (req, res) => {
    console.log('🧪 Email test endpoint called');
    
    try {
        const { testEmail } = req.body;
        
        console.log('📧 Test email requested for:', testEmail);
        
        if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
            console.error('❌ Invalid testEmail:', testEmail);
            return res.status(400).json({ 
                success: false, 
                error: 'Valid testEmail is required (e.g., user@gmail.com)' 
            });
        }
        
        console.log('📤 Calling sendConfirmationEmail...');
        const emailResult = await sendConfirmationEmail(testEmail, {
            playerName: 'Test de Diagnóstico',
            uid: '0000000000',
            date: new Date().toLocaleString('es-ES')
        });
        
        console.log('📧 Email result:', emailResult);
        
        res.json({
            success: emailResult === true,
            message: emailResult === true 
                ? '✅ Test email sent - check your inbox AND spam folder' 
                : '❌ Email send failed - see Render logs for details',
            emailResult,
            timestamp: new Date().toISOString(),
            config: {
                EMAIL_USER: process.env.EMAIL_USER ? '✅ Set' : '❌ Missing',
                EMAIL_PASS: process.env.EMAIL_PASS ? `✅ Set (${process.env.EMAIL_PASS.length} chars)` : '❌ Missing',
                hasSpaces: process.env.EMAIL_PASS?.includes(' ') ? '⚠️ YES - Remove spaces!' : '✅ No spaces'
            }
        });
        
    } catch (error) {
        console.error('❌ Email test endpoint error:', {
            message: error.message,
            stack: error.stack?.substring(0, 200)
        });
        res.status(500).json({ 
            success: false, 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/api/admin/email/diagnose', requireAdminAuth, authLimiter, (req, res) => {
    const transporter = getTransporter();
    
    res.json({
        success: true,
        config: {
            EMAIL_USER: process.env.EMAIL_USER ? '✅ Set' : '❌ Missing',
            EMAIL_PASS: process.env.EMAIL_PASS ? `✅ Set (${process.env.EMAIL_PASS.length} chars)` : '❌ Missing',
            EMAIL_FROM: process.env.EMAIL_FROM || 'Not set',
            hasSpacesInPass: process.env.EMAIL_PASS?.includes(' ') ? '⚠️ YES' : '✅ No'
        },
        transporter: {
            exists: !!transporter,
            ready: transporter ? require('./utils/email').transporterReady : false
        },
        message: !process.env.EMAIL_USER || !process.env.EMAIL_PASS
            ? '❌ Email not configured: Add EMAIL_USER and EMAIL_PASS in Render Environment'
            : transporter 
                ? '✅ Email transporter ready' 
                : '⏳ Transporter initializing or failed to connect',
        timestamp: new Date().toISOString()
    });
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
        const participantCount = await RaffleParticipant.count();
        const recentParticipants = await RaffleParticipant.findAll({
            attributes: ['id', 'player_name', 'created_at'],
            order: [['created_at', 'DESC']],
            limit: 5
        });
        
        res.json({
            success: true,
            database: dbInfo,
            stats: {
                total_participants: participantCount,
                recent: recentParticipants
            },
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
// 🎬 WINNER VIDEO ROUTES (Admin + Public)
// ═══════════════════════════════════════════════════════════

// 📤 UPLOAD VIDEO - POST /api/admin/raffle/videos/upload
app.post('/api/admin/raffle/videos/upload', 
    requireAdminAuth, 
    authLimiter, 
    videoUpload.single('winner_video'), 
    async (req, res) => {
        try {
            const { participant_id, draw_date, description } = req.body;
            
            if (!participant_id || !draw_date) {
                return res.status(400).json({ success: false, error: 'participant_id and draw_date are required' });
            }
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'Video file is required' });
            }
            
            if (!process.env.CLOUDINARY_CLOUD_NAME) {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Cloudinary not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to env vars.' 
                });
            }
            
            // Subir a Cloudinary
            const uploadPromise = new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    {
                        resource_type: 'video',
                        folder: 'freefire_raffle/winners',
                        public_id: `winner_${participant_id}_${Date.now()}`,
                        transformation: [
                            { width: 1280, height: 720, crop: 'limit' },
                            { quality: 'auto:good' }
                        ]
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
            });
            
            const uploadResult = await uploadPromise;
            
            // Guardar en BD
            const videoRecord = await createWinnerVideo({
                participant_id: parseInt(participant_id, 10),
                video_url: uploadResult.secure_url,
                video_public_id: uploadResult.public_id,
                original_filename: req.file.originalname,
                file_size: req.file.size,
                mime_type: req.file.mimetype,
                draw_date: new Date(draw_date).toISOString().split('T')[0],
                description: description?.trim() || null,
                is_public: true,
                uploaded_by: getClientIP(req)
            });
            
            console.log(`🎬 Video uploaded: ${uploadResult.public_id} for winner #${participant_id}`);
            
            res.json({
                success: true,
                message: 'Video uploaded successfully',
                video: {
                    id: videoRecord.id,
                    url: videoRecord.video_url,
                    thumbnail: uploadResult.thumbnail_url,
                    duration: uploadResult.duration,
                    original_filename: videoRecord.original_filename,
                    draw_date: videoRecord.draw_date,
                    description: videoRecord.description,
                    uploaded_at: videoRecord.uploaded_at
                }
            });
            
        } catch (error) {
            console.error('❌ Error uploading winner video:', error.message);
            res.status(500).json({ 
                success: false, 
                error: 'Upload failed: ' + error.message 
            });
        }
    }
);


//📥LIST VIDEOS - ADMIN - GET /api/admin/raffle/videos
app.get('/api/admin/raffle/videos', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const offset = parseInt(req.query.offset, 10) || 0;
        const videos = await getWinnerVideos(true, limit, offset);
        const total = await WinnerVideo.count();
        res.json({ success: true, count: videos.length, total, pagination: { limit, offset, hasMore: offset + limit < total }, videos });
    } catch (error) {
        console.error('❌ Error listing admin videos:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🌐 LIST VIDEOS - PUBLIC - GET /api/raffle/videos ✅ ESTE ES EL ENDPOINT QUE BUSCAS
app.get('/api/raffle/videos', async (req, res) => {
    console.log(`🎬 Public videos request: limit=${req.query.limit || 12}, offset=${req.query.offset || 0}`);
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 12, 24);
        const offset = parseInt(req.query.offset, 10) || 0;
        const videos = await getWinnerVideos(false, limit, offset);
        console.log(`✅ Loaded ${videos.length} winner videos from database`);
        const publicVideos = videos.map(v => ({
            id: v.id, url: v.video_url,
            thumbnail: v.video_url?.replace('/upload/', '/upload/w_400,h_225,c_fill/') || null,
            duration: null, winner_name: v.winner?.player_name || 'Ganador',
            draw_date: v.draw_date, description: v.description, uploaded_at: v.uploaded_at
        }));
        res.json({ success: true, count: publicVideos.length, videos: publicVideos });
    } catch (error) {
        console.error('❌ Error listing public videos:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});


// 🗑️ DELETE VIDEO - DELETE /api/admin/raffle/videos/:id
app.delete('/api/admin/raffle/videos/:id', requireAdminAuth, authLimiter, async (req, res) => {
    try {
        const videoId = parseInt(req.params.id, 10);
        if (isNaN(videoId)) {
            return res.status(400).json({ success: false, error: 'Invalid video ID' });
        }
        
        const video = await getWinnerVideoById(videoId, true);
        if (!video) {
            return res.status(404).json({ success: false, error: 'Video not found' });
        }
        
        // Eliminar de Cloudinary si existe
        if (video.video_public_id && process.env.CLOUDINARY_API_KEY) {
            try {
                await cloudinary.uploader.destroy(video.video_public_id, { resource_type: 'video' });
                console.log(`🗑️ Cloudinary file deleted: ${video.video_public_id}`);
            } catch (cloudErr) {
                console.warn('⚠️ Could not delete from Cloudinary:', cloudErr.message);
            }
        }
        
        const result = await deleteWinnerVideo(videoId);
        
        res.json({
            success: true,
            message: 'Video deleted successfully',
            deleted_id: videoId
        });
        
    } catch (error) {
        console.error('❌ Error deleting winner video:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔍 GET SINGLE VIDEO - GET /api/raffle/videos/:id
app.get('/api/raffle/videos/:id', async (req, res) => {
    try {
        const videoId = parseInt(req.params.id, 10);
        if (isNaN(videoId)) {
            return res.status(400).json({ success: false, error: 'Invalid video ID' });
        }
        
        const video = await getWinnerVideoById(videoId, false);
        if (!video) {
            return res.status(404).json({ success: false, error: 'Video not found or not public' });
        }
        
        res.json({
            success: true,
            video: {
                id: video.id,
                url: video.video_url,
                winner_name: video.winner?.player_name || 'Ganador',
                draw_date: video.draw_date,
                description: video.description,
                uploaded_at: video.uploaded_at,
                file_info: {
                    original_name: video.original_filename,
                    size_mb: (video.file_size / 1024 / 1024).toFixed(2),
                    mime_type: video.mime_type
                }
            }
        });
    } catch (error) {
        console.error('❌ Error fetching single video:', error.message);
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
    console.log(`🎁 Raffle system: /api/raffle/*`);
    console.log(`🎛️ Admin panel: /api/admin/raffle/* (protected)`);
    console.log(`🎬 Winner videos: /api/raffle/videos (public), /api/admin/raffle/videos/* (admin)`);
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
        await syncWinnerVideoTable();
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