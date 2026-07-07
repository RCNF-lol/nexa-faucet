// generate-wallet.js
const { Wallet, rostrumProvider } = require('nexa-wallet-sdk');

async function generateWallet() {
    try {
        // ✅ 1. Conectar al proveedor (nodo de Nexa)
        console.log('🔌 Conectando al nodo de Nexa...');
        await rostrumProvider.connect('mainnet'); // o 'testnet'
        console.log('✅ Conectado al nodo oficial.');

        // ✅ 2. Generar mnemonic
        const mnemonic = require('bip39').generateMnemonic(256);
        console.log('\n🔐 MNEMONIC (GUÁRDALO EN SECRETO):', mnemonic);

        // ✅ 3. Crear billetera
        const wallet = new Wallet(mnemonic, 'mainnet');
        console.log('\n🔄 Inicializando billetera... (descubriendo cuentas)');
        await wallet.initialize(); // ⚠️ ¡Este paso es obligatorio!

        // ✅ 4. Obtener cuenta y dirección
        const account = wallet.accountStore.getAccount('1.0');
        if (!account) throw new Error('No se creó ninguna cuenta');

        const address = account.getNewAddress();
        console.log('\n📬 Dirección principal:', address.toString());

        // ✅ 5. Verificar saldo
        console.log('\n🔍 Obteniendo saldo actual...');
        const balance = account.balance;
        console.log('💰 Confirmed:', balance.confirmed / 100000000, 'NEXA');
        console.log('🕒 Unconfirmed:', balance.unconfirmed / 100000000, 'NEXA');

    } catch (error) {
        console.error('❌ Error crítico:', error.message);
        console.error('📝 Detalles:', error.stack);
    }
}

generateWallet();