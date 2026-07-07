// test-wallet.js
require('dotenv').config();
const { Wallet } = require('nexa-wallet-sdk');

try {
    const wallet = new Wallet(process.env.MNEMONIC);
    console.log('✅ Dirección generada:', wallet.address);
} catch (error) {
    console.error('❌ Error:', error.message);
}