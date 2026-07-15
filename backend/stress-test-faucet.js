// stress-test-faucet.js

const fetch = require('node-fetch'); // Asegúrate de tener node-fetch@2 instalado

const ADDRESSES = [
  "nexa:nqtsq5g59gv2hgr86s6q0vkawss0spvmdh9ujze3q8c98tgr",
  "nexa:nqtsq5g5f27ss40jtntkc0p3n6er74jq6pmlt2dsw58ujzdh",
  "nexa:nqtsq5g5keys256h02xzzc77jz99fjpdl98wd7tlcgzzcqdj",
  "nexa:nqtsq5g5kjtmyxla8az2jpv4g76m3updmaugruqmztf4awcv",
  "nexa:nqtsq5g5f7f8h4dhyn07jvxsash6te8q5yyhcr2x5j36cwkw",
  "nexa:nqtsq5g5mhvjvkmjnjt9kr5ee7kmpynmc09wfd2xdnsk4kw4",
  "nexa:nqtsq5g5scjkz7d48u60hvh95ljzluvwf64tlp0kt3fepq8h",
  "nexa:nqtsq5g5hp53y9lpa9rxsn7pzgculw4w3w8smqa3t0yxw4ex"
];

const FAUCET_URL = 'http://localhost:3000/request'; // ⚠️ Cambia esto si tu faucet está en otro lugar

async function requestFaucet(address) {
  try {
    const response = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ address })
    });

    const status = response.status;
    const data = await response.text();

    console.log(`[✅ ${status}] ${address} → ${data.substring(0, 100).trim()}`);
    return { address, status, success: response.ok };
  } catch (error) {
    console.error(`[❌ ERROR] ${address} →`, error.message);
    return { address, error: error.message };
  }
}

async function runStressTest(rounds = 1) {
  console.log(`🚀 Iniciando prueba de estrés (${rounds} ronda(s)) con ${ADDRESSES.length} direcciones...\n`);

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n--- Ronda ${round} ---`);
    const promises = ADDRESSES.map(addr => requestFaucet(addr));
    await Promise.all(promises);
    if (round < rounds) await new Promise(r => setTimeout(r, 2000)); // Pausa entre rondas
  }

  console.log(`\n🏁 Prueba finalizada.`);
}

// Ejecutar con: node stress-test-faucet.js [número de rondas]
const rounds = parseInt(process.argv[2]) || 1;
runStressTest(rounds);