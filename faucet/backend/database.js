// backend/database.js

const { Sequelize, DataTypes, Op, Transaction } = require('sequelize');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════
// 🔧 CONEXIÓN A BASE DE DATOS - AUTO-DETECT ENTORNO
// ═══════════════════════════════════════════════════════════

// Detectar si estamos en producción (Render) o desarrollo local
const isProduction = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';

let sequelize;
let usePostgreSQL = false;

if (isProduction && process.env.DATABASE_URL) {
    // ✅ PRODUCCIÓN: Usar PostgreSQL en Render
    usePostgreSQL = true;
    console.log('🗄️  Production mode: Using PostgreSQL');
    
    if (!process.env.DATABASE_URL) {
        console.error('❌ FATAL: DATABASE_URL no está definida en producción');
        process.exit(1);
    }
    
    sequelize = new Sequelize(process.env.DATABASE_URL, {
        dialect: 'postgres',
        logging: false,  // Desactivar logging en producción para rendimiento
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        },
        dialectOptions: {
            ssl: { require: true, rejectUnauthorized: false },
            keepAlive: true
        },
        retry: {
            match: [/ConnectionTimeoutError/, /ConnectionRefusedError/, /SequelizeConnectionError/, /ETIMEDOUT/],
            max: 3
        },
        define: {
            timestamps: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at'
        }
    });
    
} else {
    // ✅ DESARROLLO LOCAL: Usar Sequelize con SQLite nativo (NO mock)
    usePostgreSQL = false;
    console.log('🗄️  Development mode: Using SQLite via Sequelize');
    
    const dbPath = path.join(__dirname, 'faucet_dev.db');
    
    sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: dbPath,
        logging: process.env.NODE_ENV === 'development' ? console.log : false,
        define: {
            timestamps: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at'
        }
    });
    
    console.log(`✅ SQLite database: ${dbPath}`);
}

// Verificar conexión
(async () => {
    try {
        await sequelize.authenticate();
        console.log(`✅ ${usePostgreSQL ? 'PostgreSQL' : 'SQLite'} connection established`);
    } catch (error) {
        console.error(`❌ FATAL: Unable to connect to ${usePostgreSQL ? 'PostgreSQL' : 'SQLite'}:`, {
            message: error.message,
            code: error.code,
            name: error.name
        });
        if (usePostgreSQL) {
            console.error('💡 Verifica que DATABASE_URL sea correcta y la DB esté accesible desde Render');
        } else {
            console.error('💡 Verifica permisos de escritura en la carpeta del proyecto');
        }
        process.exit(1);
    }
})();

// ═══════════════════════════════════════════════════════════
// 🗂️ DEFINICIÓN DE MODELOS
// ═══════════════════════════════════════════════════════════

// Modelo: requests (faucet cooldowns)
const Request = sequelize.define('request', {
    address: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: { isLowercase: true },
        set(value) { this.setDataValue('address', value.toLowerCase()); }
    },
    last_request: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Timestamp en milisegundos'
    }
}, {
    tableName: 'requests',
    timestamps: false,
    indexes: [
        { fields: ['last_request'] },
        { fields: ['address'], unique: true }
    ]
});

// Modelo: raffle_participants
const RaffleParticipant = sequelize.define('raffle_participant', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    ff_uid: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: { len: [8, 12] }
    },
    player_name: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: { len: [3, 20] }
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
        set(value) { this.setDataValue('email', value?.toLowerCase()); }
    },
    fingerprint: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    ip_address: { type: DataTypes.STRING },
    is_winner: { type: DataTypes.BOOLEAN, defaultValue: false },
    notified: { type: DataTypes.BOOLEAN, defaultValue: false },
    verified: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
    tableName: 'raffle_participants',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        { fields: ['ff_uid'] },
        { fields: ['email'], unique: true },
        { fields: ['fingerprint'], unique: true },
        { fields: ['is_winner'], where: { is_winner: true } },
        { fields: ['created_at'], order: 'DESC' }
    ]
});

// ✅ FIX: Config model - REMOVE 'description' column to match actual DB schema
const Config = sequelize.define('config', {
    key: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        unique: true
    },
    value: { type: DataTypes.TEXT }
    // ❌ REMOVED: description field that doesn't exist in actual PostgreSQL table
}, {
    tableName: 'config',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

// ═══════════════════════════════════════════════════════════
// 🔄 FUNCIONES DE INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════

async function initializeFaucetTable() {
    try {
        await Request.sync({ alter: true });
        console.log('🗃️ Table "requests" synced');
    } catch (err) {
        console.error('❌ Error syncing requests table:', err.message);
        throw err;
    }
}

async function initializeRaffleTable() {
    try {
        await RaffleParticipant.sync({ alter: true });
        console.log('✅ Table "raffle_participants" synced');
    } catch (err) {
        console.error('❌ Error syncing raffle_participants table:', err.message);
        throw err;
    }
}

async function initializeConfigTable() {
    try {
        await Config.sync({ alter: true });
        console.log('✅ Table "config" synced');
        
        // Valores por defecto para config (sin description para evitar error)
        const defaultConfigs = [
            { key: 'RAFFLE_END_DATE', value: process.env.RAFFLE_END_DATE || '2026-04-30T23:59:59Z' },
            { key: 'RAFFLE_PRIZE_DESC', value: process.env.RAFFLE_PRIZE_DESC || 'Elite Pass - 30 days' },
            { key: 'MAX_PARTICIPANTS', value: '10000' }
        ];
        
        for (const cfg of defaultConfigs) {
            await Config.findOrCreate({
                where: { key: cfg.key },
                defaults: { value: cfg.value }
            });
        }
        console.log('✅ Default config values initialized');
    } catch (err) {
        console.error('❌ Error syncing config table:', err.message);
        throw err;
    }
}

async function initializeTables() {
    await initializeFaucetTable();
    await initializeRaffleTable();
    await initializeConfigTable();
    console.log('✅ All tables initialized successfully');
}

// ═══════════════════════════════════════════════════════════
// ⚙️ CONFIG TABLE HELPERS (persistencia in-DB)
// ═══════════════════════════════════════════════════════════

async function getConfig(key, defaultValue = null) {
    try {
        const config = await Config.findByPk(key);
        return config?.value ?? defaultValue;
    } catch (err) {
        console.error(`❌ Error getting config "${key}":`, err.message);
        return defaultValue;
    }
}

async function setConfig(key, value) {
    try {
        const [config] = await Config.upsert({
            key,
            value,
            updated_at: new Date()
        });
        console.log(`⚙️ Config updated: ${key} = ${value}`);
        return true;
    } catch (err) {
        console.error(`❌ Error setting config "${key}":`, err.message);
        throw err;
    }
}

async function getAllConfig() {
    try {
        const configs = await Config.findAll({ order: [['key', 'ASC']] });
        const result = {};
        configs.forEach(cfg => { result[cfg.key] = cfg.value; });
        return result;
    } catch (err) {
        console.error('❌ Error fetching all config:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// 🚰 FUNCIONES DEL FAUCET
// ═══════════════════════════════════════════════════════════

async function canRequest(address) {
    try {
        const record = await Request.findOne({
            where: { address: address.toLowerCase() }
        });
        
        if (!record) return true;
        
        const cooldownMs = parseInt(process.env.COOLDOWN_MS, 10) || 86400000;
        const nowMs = Date.now();
        const elapsedMs = nowMs - record.last_request;
        
        return elapsedMs > cooldownMs;
    } catch (err) {
        console.error('❌ Error checking request cooldown:', err.message);
        throw err;
    }
}

async function saveRequest(address) {
    try {
        const nowMs = Date.now();
        await Request.upsert({
            address: address.toLowerCase(),
            last_request: nowMs
        });
    } catch (err) {
        console.error('❌ Error saving faucet request:', err.message);
        throw err;
    }
}

async function clearAllCooldowns() {
    try {
        const deleted = await Request.destroy({ where: {} });
        console.log(`🧹 Cleared ${deleted} cooldown records`);
        return deleted;
    } catch (err) {
        console.error('❌ Error clearing cooldowns:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// 🎁 FUNCIONES DE SORTEO (RAFFLE)
// ═══════════════════════════════════════════════════════════

async function getAllParticipants(includeSensitive = false) {
    try {
        const attributes = includeSensitive
            ? ['id', 'ff_uid', 'player_name', 'email', 'fingerprint', 'ip_address', 'is_winner', 'notified', 'verified', 'created_at', 'updated_at']
            : ['id', 'player_name', 'created_at', 'is_winner', 'notified'];
        
        const participants = await RaffleParticipant.findAll({
            attributes,
            order: [['created_at', 'DESC']]
        });
        return participants.map(p => p.toJSON());
    } catch (err) {
        console.error('❌ Error fetching participants:', err.message);
        throw err;
    }
}

async function getRaffleStats() {
    try {
        const [total, winners, notified, first, last] = await Promise.all([
            RaffleParticipant.count(),
            RaffleParticipant.count({ where: { is_winner: true } }),
            RaffleParticipant.count({ where: { notified: true } }),
            RaffleParticipant.findOne({ attributes: ['created_at'], order: [['created_at', 'ASC']] }),
            RaffleParticipant.findOne({ attributes: ['created_at'], order: [['created_at', 'DESC']] })
        ]);
        
        return {
            total: total || 0,
            winners: winners || 0,
            notified: notified || 0,
            first_registration: first?.created_at || null,
            last_registration: last?.created_at || null
        };
    } catch (err) {
        console.error('❌ Error getting raffle stats:', err.message);
        throw err;
    }
}

// ✅ Transacción atómica para prevenir race conditions
async function selectRandomWinner() {
    let transaction;
    try {
        transaction = await sequelize.transaction();
        
        const participants = await RaffleParticipant.findAll({
            where: { is_winner: false },
            attributes: ['id', 'ff_uid', 'player_name', 'email'],
            transaction,
            lock: transaction.LOCK?.UPDATE || 'FOR UPDATE'
        });
        
        if (!participants || participants.length === 0) {
            await transaction.rollback();
            return null;
        }
        
        const crypto = require('crypto');
        const randomBytes = crypto.randomBytes(4);
        const randomIndex = randomBytes.readUInt32LE(0) % participants.length;
        const winner = participants[randomIndex];
        
        await RaffleParticipant.update(
            { is_winner: true, updated_at: new Date() },
            { where: { id: winner.id }, transaction }
        );
        
        await transaction.commit();
        
        console.log(`🏆 Winner selected: ${winner.player_name} (ID: ${winner.id}, Index: ${randomIndex}/${participants.length})`);
        
        return {
            id: winner.id,
            ff_uid: winner.ff_uid,
            player_name: winner.player_name,
            email: winner.email,
            selection_index: randomIndex,
            total_participants: participants.length,
            selected_at: new Date().toISOString()
        };
        
    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error('❌ Error selecting random winner:', err.message);
        throw err;
    }
}

async function markWinnerNotified(participantId) {
    try {
        const [updated] = await RaffleParticipant.update(
            { notified: true, updated_at: new Date() },
            { where: { id: participantId, is_winner: true } }
        );
        
        if (updated > 0) {
            console.log(`✅ Winner #${participantId} marked as notified`);
            return true;
        }
        console.warn(`⚠️ Participant #${participantId} not found or not a winner`);
        return false;
    } catch (err) {
        console.error('❌ Error marking winner as notified:', err.message);
        throw err;
    }
}

// ✅ Sanitización robusta contra Excel/CSV injection
function sanitizeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value).trim();
    
    if (/^[=+\-@%]/.test(str)) {
        return `'${str}`;
    }
    
    return str.replace(/"/g, '""');
}

async function exportParticipantsToCSV() {
    try {
        const participants = await RaffleParticipant.findAll({
            attributes: ['id', 'ff_uid', 'player_name', 'email', 'ip_address', 'created_at', 'is_winner', 'notified'],
            order: [['created_at', 'DESC']]
        });
        
        const headers = ['ID', 'UID_FreeFire', 'Nombre_Jugador', 'Email', 'IP_Address', 'Fecha_Registro', 'Es_Ganador', 'Notificado'];
        const csvRows = [headers.join(',')];
        
        participants.forEach(row => {
            const values = [
                row.id,
                `"${sanitizeCSV(row.ff_uid)}"`,
                `"${sanitizeCSV(row.player_name)}"`,
                `"${sanitizeCSV(row.email)}"`,
                `"${sanitizeCSV(row.ip_address)}"`,
                row.created_at || '',
                row.is_winner ? 'Sí' : 'No',
                row.notified ? 'Sí' : 'No'
            ];
            csvRows.push(values.join(','));
        });
        
        return '\uFEFF' + csvRows.join('\n');
    } catch (err) {
        console.error('❌ Error exporting participants to CSV:', err.message);
        throw err;
    }
}

async function deleteParticipant(id) {
    try {
        const deleted = await RaffleParticipant.destroy({ where: { id } });
        
        if (deleted > 0) {
            console.log(`🗑️ Participant #${id} deleted successfully`);
            return true;
        }
        console.warn(`⚠️ Participant #${id} not found for deletion`);
        return false;
    } catch (err) {
        console.error('❌ Error deleting participant:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// 🗑️ RESET RAFFLE (con transacción atómica + config in-DB)
// ═══════════════════════════════════════════════════════════

async function resetRaffle() {
    let transaction;
    try {
        transaction = await sequelize.transaction();
        
        const deleted = await RaffleParticipant.destroy({
            where: {},
            transaction
        });
        
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + 30);
        const newEndDateISO = newEndDate.toISOString();
        
        await Config.upsert({
            key: 'RAFFLE_END_DATE',
            value: newEndDateISO,
            updated_at: new Date()
        }, { transaction });
        
        await transaction.commit();
        
        console.log(`🗑️ Raffle reset complete: ${deleted} participants deleted`);
        console.log(`📅 New end date set in DB: ${newEndDateISO}`);
        
        return {
            success: true,
            deleted: deleted || 0,
            new_end_date: newEndDateISO,
            timestamp: new Date().toISOString()
        };
        
    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error('❌ Error resetting raffle:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// 🔍 BÚSQUEDA DE PARTICIPANTES - COMPATIBLE CON AMBOS DIALECTOS
// ═══════════════════════════════════════════════════════════

async function searchParticipants(searchTerm) {
    try {
        if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim().length < 2) {
            return [];
        }
        
        const sanitized = searchTerm
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_')
            .trim();
        
        const likeTerm = `%${sanitized}%`;
        
        // ✅ FIX: Construir condiciones compatibles con PostgreSQL y SQLite
        const whereConditions = [];
        
        if (usePostgreSQL) {
            // PostgreSQL: usar iLike para case-insensitive
            whereConditions.push(
                { ff_uid: { [Op.like]: likeTerm } },
                { email: { [Op.iLike]: likeTerm } },
                { player_name: { [Op.iLike]: likeTerm } }
            );
        } else {
            // SQLite: usar LOWER + LIKE para case-insensitive
            whereConditions.push(
                { ff_uid: { [Op.like]: likeTerm } },
                sequelize.where(sequelize.fn('LOWER', sequelize.col('email')), { [Op.like]: likeTerm.toLowerCase() }),
                sequelize.where(sequelize.fn('LOWER', sequelize.col('player_name')), { [Op.like]: likeTerm.toLowerCase() })
            );
        }
        
        const participants = await RaffleParticipant.findAll({
            where: { [Op.or]: whereConditions },
            attributes: ['id', 'ff_uid', 'player_name', 'email', 'created_at', 'is_winner', 'notified'],
            order: [['created_at', 'DESC']],
            limit: 50
        });
        
        return participants.map(p => p.toJSON());
    } catch (err) {
        console.error('❌ Error searching participants:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// 🔧 UTILIDADES DE BASE DE DATOS - COMPATIBLE CON AMBOS DIALECTOS
// ═══════════════════════════════════════════════════════════

async function ensureDbConnected() {
    try {
        await sequelize.authenticate();
        return true;
    } catch (err) {
        console.error('❌ Database connection check failed:', err.message);
        return false;
    }
}

async function closeDatabase() {
    try {
        await sequelize.close();
        console.log('✅ Database connection closed successfully');
    } catch (err) {
        console.error('❌ Error closing database connection:', err.message);
        throw err;
    }
}

async function getDbInfo() {
    try {
        if (usePostgreSQL) {
            // PostgreSQL query
            const [tables] = await sequelize.query(`
                SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
                FROM information_schema.tables 
                WHERE table_schema = 'public'
                AND table_name IN ('requests', 'raffle_participants', 'config')
            `);
            
            const [reqCount, partCount, configCount] = await Promise.all([
                Request.count(),
                RaffleParticipant.count(),
                Config.count()
            ]);
            
            return {
                type: 'PostgreSQL',
                host: sequelize.config.host,
                database: sequelize.config.database,
                port: sequelize.config.port,
                connected: true,
                tables: tables || [],
                row_counts: {
                    requests: reqCount,
                    raffle_participants: partCount,
                    config: configCount
                },
                pool_info: sequelize.pool,
                render_mode: !!process.env.RENDER
            };
        } else {
            // ✅ SQLite fallback
            const dbPath = path.join(__dirname, 'faucet_dev.db');
            const size = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
            
            const [reqCount, partCount, configCount] = await Promise.all([
                Request.count(),
                RaffleParticipant.count(),
                Config.count()
            ]);
            
            return {
                type: 'SQLite',
                host: 'localhost',
                database: 'faucet_dev.db',
                port: null,
                connected: true,
                tables: ['requests', 'raffle_participants', 'config'],
                row_counts: {
                    requests: reqCount,
                    raffle_participants: partCount,
                    config: configCount
                },
                size_bytes: size,
                size_mb: (size / 1024 / 1024).toFixed(2),
                render_mode: false
            };
        }
    } catch (err) {
        console.error('❌ Error getting DB info:', err.message);
        throw err;
    }
}

async function checkHealth() {
    try {
        await sequelize.query('SELECT 1');
        return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (err) {
        return { status: 'unhealthy', error: err.message, timestamp: new Date().toISOString() };
    }
}

// ═══════════════════════════════════════════════════════════
// 🔒 FUNCIONES DE SEGURIDAD / ANTI-FRAUDE (Pro+)
// ═══════════════════════════════════════════════════════════

async function checkParticipantLimit(maxParticipants = 10000) {
    try {
        const limitFromConfig = parseInt(await getConfig('MAX_PARTICIPANTS'), 10);
        const limit = !isNaN(limitFromConfig) ? limitFromConfig 
            : parseInt(process.env.MAX_PARTICIPANTS, 10) || maxParticipants;
        
        const count = await RaffleParticipant.count();
        
        if (count >= limit) {
            console.warn(`⚠️ Participant limit reached: ${count}/${limit} - New registrations blocked`);
            return false;
        }
        return true;
    } catch (err) {
        console.error('❌ Error checking participant limit:', err.message);
        return false;
    }
}

function hashEmail(email) {
    if (!email) return null;
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

async function cleanupOldRecords(days = 90) {
    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        
        const deleted = await RaffleParticipant.destroy({
            where: {
                created_at: { [Op.lt]: cutoffDate },
                is_winner: false,
                notified: false
            }
        });
        
        if (deleted > 0) {
            console.log(`🧹 Cleanup: Removed ${deleted} old non-winner, non-notified records`);
        }
        return deleted;
    } catch (err) {
        console.error('❌ Error cleaning up old records:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// 🎬 MODELO: WinnerVideo (Videos de ganadores)
// ═══════════════════════════════════════════════════════════

const WinnerVideo = sequelize.define('winner_video', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    participant_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: RaffleParticipant,
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    video_url: {
        type: DataTypes.STRING(500),
        allowNull: false,
        comment: 'URL pública del video (Cloudinary/S3)'
    },
    video_public_id: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'ID público para gestión en Cloudinary'
    },
    original_filename: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    file_size: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Tamaño en bytes'
    },
    mime_type: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
            isIn: [['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']]
        }
    },
    draw_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: 'Fecha del sorteo'
    },
    description: {
        type: DataTypes.STRING(200),
        allowNull: true
    },
    is_public: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    uploaded_by: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'IP o ID del admin que subió el video'
    }
}, {
    tableName: 'winner_videos',
    timestamps: true,
    createdAt: 'uploaded_at',
    updatedAt: false,
    indexes: [
        { fields: ['participant_id'] },
        { fields: ['draw_date'], order: 'DESC' },
        { fields: ['is_public', 'draw_date'], where: { is_public: true } },
        { fields: ['video_public_id'], unique: true, where: { video_public_id: { [Op.ne]: null } } }
    ]
});

// Relación: Un ganador puede tener un video de prueba
WinnerVideo.belongsTo(RaffleParticipant, { 
    foreignKey: 'participant_id', 
    as: 'winner',
    constraints: true
});
RaffleParticipant.hasOne(WinnerVideo, {
    foreignKey: 'participant_id',
    as: 'winner_video',
    constraints: false // Un ganador puede no tener video aún
});

// ═══════════════════════════════════════════════════════════
// 🎬 FUNCIONES CRUD PARA WINNER VIDEOS
// ═══════════════════════════════════════════════════════════

async function createWinnerVideo(data) {
    try {
        // Verificar que el participante existe y es ganador
        const participant = await RaffleParticipant.findByPk(data.participant_id);
        if (!participant) {
            throw new Error('Participant not found');
        }
        if (!participant.is_winner) {
            throw new Error('Only winners can have proof videos');
        }
        
        // Verificar que no tenga video ya
        const existing = await WinnerVideo.findOne({ 
            where: { participant_id: data.participant_id } 
        });
        if (existing) {
            throw new Error('This winner already has a video uploaded');
        }
        
        const video = await WinnerVideo.create({
            participant_id: data.participant_id,
            video_url: data.video_url,
            video_public_id: data.video_public_id || null,
            original_filename: data.original_filename,
            file_size: data.file_size,
            mime_type: data.mime_type,
            draw_date: data.draw_date,
            description: data.description || null,
            is_public: data.is_public !== false,
            uploaded_by: data.uploaded_by || null
        });
        
        console.log(`🎬 Winner video created: ${video.original_filename} for participant #${data.participant_id}`);
        return video.toJSON();
    } catch (err) {
        console.error('❌ Error creating winner video:', err.message);
        throw err;
    }
}

async function getWinnerVideos(adminView = false, limit = 20, offset = 0) {
    try {
        const where = adminView ? {} : { is_public: true };
        
        const videos = await WinnerVideo.findAll({
            where,
            attributes: [
                'id', 'participant_id', 'video_url', 'original_filename', 
                'file_size', 'mime_type', 'draw_date', 'description', 
                'is_public', 'uploaded_at'
            ],
            include: [{
                model: RaffleParticipant,
                as: 'winner',
                attributes: adminView 
                    ? ['id', 'ff_uid', 'player_name', 'email'] 
                    : ['id', 'player_name']
            }],
            order: [['draw_date', 'DESC'], ['uploaded_at', 'DESC']],
            limit,
            offset
        });
        
        return videos.map(v => v.toJSON());
    } catch (err) {
        console.error('❌ Error fetching winner videos:', err.message);
        throw err;
    }
}

async function getWinnerVideoById(videoId, adminView = false) {
    try {
        const where = adminView ? { id: videoId } : { id: videoId, is_public: true };
        
        const video = await WinnerVideo.findOne({
            where,
            attributes: [
                'id', 'participant_id', 'video_url', 'video_public_id',
                'original_filename', 'file_size', 'mime_type', 'draw_date', 
                'description', 'is_public', 'uploaded_at'
            ],
            include: [{
                model: RaffleParticipant,
                as: 'winner',
                attributes: adminView 
                    ? ['id', 'ff_uid', 'player_name', 'email'] 
                    : ['id', 'player_name']
            }]
        });
        
        return video ? video.toJSON() : null;
    } catch (err) {
        console.error('❌ Error fetching winner video:', err.message);
        throw err;
    }
}

async function getWinnerVideoByParticipant(participantId) {
    try {
        const video = await WinnerVideo.findOne({
            where: { participant_id: participantId },
            attributes: ['id', 'video_url', 'original_filename', 'draw_date', 'description', 'uploaded_at'],
            include: [{
                model: RaffleParticipant,
                as: 'winner',
                attributes: ['id', 'player_name']
            }]
        });
        return video ? video.toJSON() : null;
    } catch (err) {
        console.error('❌ Error fetching video by participant:', err.message);
        throw err;
    }
}

async function deleteWinnerVideo(videoId) {
    let transaction;
    try {
        transaction = await sequelize.transaction();
        
        const video = await WinnerVideo.findByPk(videoId, { transaction });
        if (!video) {
            await transaction.rollback();
            return { success: false, error: 'Video not found' };
        }
        
        // Si tiene video_public_id, eliminar de Cloudinary (se hace en server.js)
        const videoData = video.toJSON();
        
        await WinnerVideo.destroy({ 
            where: { id: videoId },
            transaction 
        });
        
        await transaction.commit();
        
        console.log(`🗑️ Winner video deleted: ID ${videoId}`);
        return { success: true, deleted_id: videoId, video_public_id: videoData.video_public_id };
    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error('❌ Error deleting winner video:', err.message);
        throw err;
    }
}

async function updateWinnerVideo(videoId, updates) {
    try {
        const [updated] = await WinnerVideo.update(updates, {
            where: { id: videoId },
            returning: true
        });
        
        if (updated > 0) {
            const video = await WinnerVideo.findByPk(videoId);
            console.log(`✏️ Winner video updated: ID ${videoId}`);
            return video.toJSON();
        }
        return null;
    } catch (err) {
        console.error('❌ Error updating winner video:', err.message);
        throw err;
    }
}

async function syncWinnerVideoTable() {
    try {
        await WinnerVideo.sync({ alter: true });
        console.log('✅ Table "winner_videos" synced');
    } catch (err) {
        console.error('❌ Error syncing winner_videos table:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════
// ✅ EXPORTS COMPLETOS - CON usePostgreSQL INCLUIDO
// ═══════════════════════════════════════════════════════════

module.exports = {
    sequelize,
    Sequelize,
    Op,
    usePostgreSQL,
    
    // Modelos
    Request,
    RaffleParticipant,
    Config,
    WinnerVideo,  // ✅ NUEVO
    
    // Initialization
    initializeTables,
    initializeFaucetTable,
    initializeRaffleTable,
    initializeConfigTable,
    syncWinnerVideoTable,  // ✅ NUEVO
    
    // Faucet Functions
    canRequest,
    saveRequest,
    clearAllCooldowns,
    
    // Raffle Functions
    getAllParticipants,
    getRaffleStats,
    selectRandomWinner,
    markWinnerNotified,
    exportParticipantsToCSV,
    deleteParticipant,
    resetRaffle,
    searchParticipants,
    
    // ✅ NUEVO: Winner Video Functions
    createWinnerVideo,
    getWinnerVideos,
    getWinnerVideoById,
    getWinnerVideoByParticipant,
    deleteWinnerVideo,
    updateWinnerVideo,
    
    // Config Functions
    getConfig,
    setConfig,
    getAllConfig,
    
    // Database Utilities
    ensureDbConnected,
    closeDatabase,
    getDbInfo,
    checkHealth,
    
    // Security / Anti-Fraud
    checkParticipantLimit,
    hashEmail,
    cleanupOldRecords,
    
    // Helpers
    sanitizeCSV
};