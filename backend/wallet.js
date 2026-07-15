// backend/wallet.js
require('dotenv').config();

// ═══════════════════════════════════════════════════════════
// 🔧 CARGA DEL SDK (SIN FALLBACK - PRODUCCIÓN)
// ═══════════════════════════════════════════════════════════

let Wallet, rostrumProvider;

try {
    ({ Wallet, rostrumProvider } = require('nexa-wallet-sdk'));
    console.log('✅ nexa-wallet-sdk successfully loaded');
} catch (error) {

    console.error('❌ FATAL: nexa-wallet-sdk failed to load');
    console.error('   Error:', error.message);
    console.error('   Solution: Run "npm install nexa-wallet-sdk"');
    process.exit(1);  // ← Detener el servidor inmediatamente
}

let walletInstance = null;

// ═══════════════════════════════════════════════════════════
// 🔑 FUNCIÓN AUXILIAR: formatNEXA
// ═══════════════════════════════════════════════════════════
function formatNEXA(satoshis) {
    const num = parseInt(satoshis, 10);
    if (isNaN(num)) return '0.00';
    return (num / 100).toFixed(2);
}

// ═══════════════════════════════════════════════════════════
// 💼 GESTIÓN DE WALLET
// ═══════════════════════════════════════════════════════════

const getWallet = async () => {
    if (!walletInstance) {
        const mnemonic = process.env.MNEMONIC;
        

        if (!mnemonic) {
            throw new Error('MNEMONIC not defined in environment variables. Check your configuration.');
        }
        
        
        await rostrumProvider.connect('mainnet');
        walletInstance = new Wallet(mnemonic, 'mainnet');
        await walletInstance.initialize();
        
        console.log('✅Wallet successfully initialized in mainnet');
    }
    return walletInstance;
};

// ═══════════════════════════════════════════════════════════
// 💰 FUNCIONES DE BALANCE Y DIRECCIÓN
// ═══════════════════════════════════════════════════════════

const getBalance = async () => {
    const wallet = await getWallet();
    
    
    if (!wallet?.accountStore) {
        throw new Error('wallet.accountStore is not available. Verify SDK initialization.');
    }
    
    const account = wallet.accountStore.getAccount('1.0');
    const raw = account?.balance?.confirmed;
    
    
    if (typeof raw === 'number') return Math.floor(raw);
    if (typeof raw === 'string') {
        const num = parseFloat(raw);
        if (isNaN(num)) {
            throw new Error(`Invalid balance received from the SDK.: "${raw}"`);
        }
        return Math.floor(num);
    }
    
    
    throw new Error('Unable to retrieve wallet balance. Please check your connection..');
};

const getFaucetAddress = async () => {
    const wallet = await getWallet();
    
    if (!wallet?.accountStore) {
        throw new Error('wallet.accountStore is not available. Verify SDK initialization.');
    }
    
    const account = wallet.accountStore.getAccount('1.0');
    const address = account?.getNewAddress?.()?.toString?.();
    
    if (!address) {
        throw new Error('Failed to get faucet address. Verify wallet settings.');
    }
    
    return address;
};

// ═══════════════════════════════════════════════════════════
// 🚰 FUNCIÓN DE FAUCET (ENVÍO DE FONDOS) - PRODUCCIÓN
// ═══════════════════════════════════════════════════════════

const sendFaucet = async (toAddress, amountSatoshis) => {
    
    if (!toAddress || typeof toAddress !== 'string') {
        throw new Error(`:Invalid destination address ${toAddress}`);
    }
    if (!amountSatoshis || typeof amountSatoshis !== 'number' || amountSatoshis <= 0) {
        throw new Error(`Invalid amount: ${amountSatoshis}`);
    }
    
    const wallet = await getWallet();
    const account = wallet.accountStore.getAccount('1.0');
    
    
    try {
        const built = await wallet.newTransaction(account)
            .onNetwork('mainnet')
            .sendTo(toAddress, amountSatoshis.toString())
            .populate()
            .sign()
            .build();

        
        let rawTx;
        if (built && typeof built === 'string') {
            rawTx = built;
        } else if (built?.serialize && typeof built.serialize === 'function') {
            rawTx = built.serialize();
        } else if (built?.toHex && typeof built.toHex === 'function') {
            rawTx = built.toHex();
        } else if (built?.hex) {
            rawTx = built.hex;
        } else if (built?.raw) {
            rawTx = built.raw;
        } else {
            throw new Error(`Unable to serialize transaction: Format not recognized- ${typeof built}`);
        }

        
        const txid = await wallet.sendTransaction(rawTx);
        console.log(`✅Transaction sent: ${formatNEXA(amountSatoshis)} NEXA a ${toAddress} | TXID: ${txid}`);
        return txid;
        
    } catch (error) {
        
        console.error(`❌ Error sending faucet: ${error.message}`);
        console.error(`   Detalles: toAddress=${toAddress}, amount=${amountSatoshis}`);
        throw new Error(`Faucet send failed: ${error.message}`);
    }
};

// ═══════════════════════════════════════════════════════════
// ✅ EXPORTS COMPLETOS
// ═══════════════════════════════════════════════════════════
module.exports = { 
    getWallet, 
    getBalance, 
    sendFaucet, 
    getFaucetAddress,
    formatNEXA
};