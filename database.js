// backend/database.js

const { Sequelize, DataTypes } = require('sequelize');
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
        logging: false,
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
    // ✅ DESARROLLO LOCAL: Usar SQLite
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

// Verificar conexión al iniciar
(async () => {
    try {
        await sequelize.authenticate();
        console.log(`✅ ${usePostgreSQL ? 'PostgreSQL' : 'SQLite'} connection established`);
    } catch (error) {
        console.error(`❌ FATAL: Unable to connect to database:`, error.message);
        process.exit(1);
    }
})();

// ═══════════════════════════════════════════════════════════
// 🗂️ DEFINICIÓN DE MODELOS (SOLO FAUCET)
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

// ═══════════════════════════════════════════════════════════
// 🔄 FUNCIONES DE INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════

async function initializeTables() {
    try {
        await Request.sync({ alter: true });
        console.log('🗃️ Table "requests" synced successfully');
    } catch (err) {
        console.error('❌ Error syncing requests table:', err.message);
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
        
        const cooldownMs = parseInt(process.env.COOLDOWN_MS, 10) || 86400000; // Default 24h
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
// 🔧 UTILIDADES DE BASE DE DATOS
// ═══════════════════════════════════════════════════════════

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
        const reqCount = await Request.count();
        
        if (usePostgreSQL) {
            return {
                type: 'PostgreSQL',
                host: sequelize.config.host,
                database: sequelize.config.database,
                port: sequelize.config.port,
                connected: true,
                row_counts: {
                    requests: reqCount
                },
                render_mode: !!process.env.RENDER
            };
        } else {
            // SQLite info
            const fs = require('fs');
            const dbPath = path.join(__dirname, 'faucet_dev.db');
            const size = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
            
            return {
                type: 'SQLite',
                host: 'localhost',
                database: 'faucet_dev.db',
                port: null,
                connected: true,
                row_counts: {
                    requests: reqCount
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

// ═══════════════════════════════════════════════════════════
// ✅ EXPORTS
// ═══════════════════════════════════════════════════════════

module.exports = {
    sequelize,
    Sequelize,
    usePostgreSQL,
    
    // Modelos
    Request,
    
    // Initialization
    initializeTables,
    
    // Faucet Functions
    canRequest,
    saveRequest,
    clearAllCooldowns,
    
    // Database Utilities
    closeDatabase,
    getDbInfo
};