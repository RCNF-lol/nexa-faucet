// debug-auth.js
// Ejecutar con: node debug-auth.js

// Cargar variables de entorno desde .env
require('dotenv').config();

console.log('🔍 Diagnóstico de Autenticación Admin');
console.log('=====================================');
console.log('NODE_ENV:', process.env.NODE_ENV || 'no definido');
console.log('API_SECRET configurada:', !!process.env.API_SECRET);
console.log('API_SECRET longitud:', process.env.API_SECRET?.length || 0);

if (process.env.API_SECRET) {
    console.log('API_SECRET (primeros 10 chars):', process.env.API_SECRET.substring(0, 10) + '...');
    console.log('API_SECRET tiene espacios al final:', /\s+$/.test(process.env.API_SECRET));
    console.log('API_SECRET tiene espacios al inicio:', /^\s+/.test(process.env.API_SECRET));
} else {
    console.log('❌ API_SECRET NO está definida en .env');
}

console.log('');
console.log('✅ Token esperado para frontend (copiar y pegar):');
if (process.env.API_SECRET) {
    console.log(`Bearer ${process.env.API_SECRET}`);
} else {
    console.log('⚠️ Primero configura API_SECRET en tu .env');
}

console.log('');
console.log('📋 Otras variables relevantes:');
console.log('RAFFLE_END_DATE:', process.env.RAFFLE_END_DATE || 'no definido');
console.log('PORT:', process.env.PORT || '10000 (default)');