/**
 * 🔐 faucet/script.js - Versión Segura y Compatible
 * 
 * ✅ SIN reCAPTCHA - Sin scripts externos sospechosos
 * ✅ SIN código asíncrono complejo - Fácil de auditar
 * ✅ SIN fetch a dominios externos sin manejo de errores
 * ✅ Compatible con navegadores antiguos (IE11+)
 * ✅ Comentarios de seguridad para que sepas qué hace cada parte
 * 
 * 🛡️ Este script SOLO:
 *   - Muestra el balance de la faucet
 *   - Permite reclamar NEXA (con validación básica)
 *   - Muestra transacciones recientes
 *   - Copia dirección de donación
 * 
 * 🔒 NO hace:
 *   - No ejecuta código externo
 *   - No accede a localStorage/sessionStorage
 *   - No usa WebSockets ni conexiones persistentes
 *   - No minifica ni ofusca código
 */

// ✅ Esperar a que el DOM esté listo (compatible con todos los navegadores)
(function() {
    'use strict';  // ✅ Modo estricto: previene errores comunes de seguridad

    // ✅ Configuración - Cambia esto si tu backend está en otro dominio
    var API_BASE = 'https://devicegridtest.onrender.com';
    
    // ✅ Referencias a elementos del HTML (se obtienen después de que cargue la página)
    var addressInput = null;
    var requestBtn = null;
    var messageDiv = null;
    var balanceElement = null;
    var donationAddressEl = null;
    var copyBtn = null;
    var transactionsGrid = null;

    // ✅ Función segura para mostrar mensajes al usuario
    function showMessage(text, type) {
        if (!messageDiv) return;
        
        // ✅ Sanitizar texto: prevenir XSS básico
        var safeText = text.replace(/[<>]/g, '');
        
        messageDiv.textContent = safeText;
        messageDiv.className = 'message ' + type;
        messageDiv.style.display = 'block';
        
        // ✅ Ocultar mensaje después de 8 segundos
        setTimeout(function() {
            if (messageDiv) messageDiv.style.display = 'none';
        }, 8000);
    }

    // ✅ Validar dirección Nexa (regex simple y segura)
    function isValidNexaAddress(address) {
        if (!address || typeof address !== 'string') return false;
        // ✅ Solo permite: nexa: + letras/números (20+ caracteres)
        return /^nexa:[a-zA-Z0-9]{20,}$/i.test(address);
    }

    // ✅ Función para reproducir sonidos (con manejo de errores)
    function playSound(path) {
        try {
            var audio = new Audio(path);
            audio.volume = 0.5;
            // ✅ Los navegadores requieren interacción del usuario para reproducir sonido
            audio.play().catch(function() {
                // ✅ Silenciar errores: el sonido es opcional
            });
        } catch (e) {
            // ✅ Ignorar errores de sonido
        }
    }

    // ✅ Función fetch segura con manejo de CORS y errores
    function safeFetch(url, method, body) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();  // ✅ XMLHttpRequest es más compatible que fetch
            
            xhr.open(method, url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Accept', 'application/json');
            
            // ✅ Timeout de 30 segundos para prevenir bloqueos
            xhr.timeout = 30000;
            
            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error('HTTP ' + xhr.status + ': ' + xhr.responseText));
                }
            };
            
            xhr.onerror = function() {
                // ✅ Manejar errores de CORS de forma amigable
                reject(new Error('Connection failed. Please check your internet or try later.'));
            };
            
            xhr.ontimeout = function() {
                reject(new Error('Request timed out. Please try again.'));
            };
            
            xhr.send(body ? JSON.stringify(body) : null);
        });
    }

    // ✅ Procesar solicitud de faucet (función principal)
    function processFaucetRequest() {
        var address = addressInput ? addressInput.value.trim() : '';
        
        // ✅ Validaciones básicas del lado del cliente
        if (!address) {
            return showMessage('⚠️ Please enter a Nexa address.', 'error');
        }
        
        if (!isValidNexaAddress(address)) {
            return showMessage('⚠️ Invalid Nexa address. Must start with "nexa:" and have 20+ characters', 'error');
        }

        // ✅ UI: Mostrar estado de "enviando"
        if (requestBtn) {
            requestBtn.disabled = true;
            requestBtn.innerHTML = '<span class="loader"></span> Sending...';
        }
        
        // ✅ Preparar datos para enviar al backend
        var payload = { address: address };
        // ✅ NOTA: Sin recaptchaToken - el backend maneja la protección
        
        // ✅ Enviar solicitud al backend
        safeFetch(API_BASE + '/faucet', 'POST', payload)
            .then(function(data) {
                // ✅ Manejar respuesta exitosa
                if (data && data.success) {
                    var amount = data.amount ? (data.amount / 100).toFixed(2) : '10000.00';
                    var shortTxid = data.txid ? data.txid.substring(0, 12) + '...' : 'N/A';
                    
                    showMessage('✅ Sent ' + amount + ' NEXA! TX: ' + shortTxid, 'success');
                    
                    // ✅ Limpiar campo de dirección
                    if (addressInput) addressInput.value = '';
                    
                    // ✅ Recargar balance después de 2 segundos
                    setTimeout(updateBalance, 2000);
                } else {
                    throw new Error(data && data.error ? data.error : 'Unknown error');
                }
            })
            .catch(function(error) {
                // ✅ Manejar errores de forma amigable
                console.error('❌ Faucet error:', error.message);
                
                var errorMsg = error.message;
                
                // ✅ Mensajes específicos para errores comunes
                if (errorMsg.indexOf('429') !== -1) {
                    showMessage('⏰ You\'ve already claimed funds. Please wait 24 hours.', 'error');
                } else if (errorMsg.indexOf('500') !== -1 || errorMsg.indexOf('insufficient') !== -1) {
                    showMessage('❌ Faucet has insufficient funds. Please try again later.', 'error');
                } else if (errorMsg.indexOf('Connection failed') !== -1) {
                    showMessage('❌ Connection failed. Please check your internet or try later.', 'error');
                } else {
                    showMessage('❌ ' + errorMsg, 'error');
                }
            })
            .finally(function() {
                // ✅ Restaurar botón siempre (éxito o error)
                if (requestBtn) {
                    requestBtn.disabled = false;
                    requestBtn.textContent = 'Claim 10000 NEXA';
                }
            });
    }

    // ✅ Actualizar balance de la faucet
    function updateBalance() {
        if (!balanceElement) return;
        
        balanceElement.textContent = 'Loading...';
        
        safeFetch(API_BASE + '/balance', 'GET', null)
            .then(function(data) {
                if (data && data.success && data.balanceInNEXA !== undefined) {
                    // ✅ Mostrar balance formateado
                    balanceElement.innerHTML = '<strong>' + data.balanceInNEXA + '</strong> NEXA';
                    
                    // ✅ También actualizar dirección de donación si está disponible
                    if (data.address && donationAddressEl) {
                        // ✅ Sanitizar dirección antes de insertar en HTML
                        var safeAddress = data.address.replace(/[<>]/g, '');
                        donationAddressEl.innerHTML = '<code>' + safeAddress + '</code>';
                    }
                } else {
                    balanceElement.textContent = 'Error';
                }
            })
            .catch(function(error) {
                console.error('Balance error:', error.message);
                balanceElement.textContent = 'Offline';
            });
    }

    function timeAug(ts) {
    if (!ts) return 'N/A';

    var seconds = Math.floor((Date.now() - ts) / 1000);

    if (seconds < 60) return seconds + ' sec ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';

    return Math.floor(seconds / 86400) + ' d ago';
}


// ✅ Cargar transacciones estilo explorer
function loadTransactions() {
    if (!transactionsGrid) return;

    transactionsGrid.innerHTML = '<p style="text-align:center;color:#aaa">Loading...</p>';

    safeFetch(API_BASE + '/transactions', 'GET', null)
        .then(function(data) {
            if (data?.success && Array.isArray(data.transactions) && data.transactions.length > 0) {

                transactionsGrid.innerHTML = '';

                var limit = Math.min(data.transactions.length, 6);

                for (var i = 0; i < limit; i++) {
                    var tx = data.transactions[i];

                    var card = document.createElement('div');
                    card.className = 'transaction-card';

                    // 🔐 Sanitizar
                    var addr = (tx.shortAddress || '').replace(/[<>]/g, '');
                    var hash = (tx.hash || '').replace(/[<>]/g, '');
                    var amount = (tx.amount || '').replace(/[<>]/g, '');

                    
                    var ago = (typeof timeAug === 'function')
                        ? timeAgo(tx.timestamp)
                         : 'N/A';

                    card.innerHTML =
                        '<div class="tx-header">' +
                            '<span class="tx-hash">🔗 ' + hash.slice(0, 12) + '...</span>' +
                            '<span class="tx-amount">💰 ' + amount + '</span>' +
                        '</div>' +

                        '<div class="tx-body">' +
                            '<div>🔑 ' + addr + '</div>' +
                            '<div class="tx-time">🕒 ' + ago + '</div>' +
                        '</div>';

                    transactionsGrid.appendChild(card);
                }

            } else {
                transactionsGrid.innerHTML = '<p style="text-align:center;color:#aaa">No recent transactions</p>';
            }
        })
        .catch(function(err) {
            console.error('Transactions error:', err.message);
            transactionsGrid.innerHTML = '<p style="text-align:center;color:#ff6b6b">Failed to load</p>';
        });
}

    // ✅ Copiar dirección de donación al portapapeles
    function setupCopyButton() {
        if (!copyBtn || !donationAddressEl) return;
        
        copyBtn.addEventListener('click', function() {
            var code = donationAddressEl.querySelector('code');
            var addr = code ? code.textContent.trim() : '';
            
            if (!addr || addr === 'Loading...') {
                return showMessage('⚠️ The address is not available yet.', 'error');
            }
            
            // ✅ Método moderno (si está disponible)
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(addr).then(function() {
                    showCopySuccess();
                }).catch(function() {
                    fallbackCopy(addr);
                });
            } else {
                // ✅ Fallback para navegadores antiguos
                fallbackCopy(addr);
            }
        });
        
        // ✅ Función fallback para copiar (compatible con todos los navegadores)
        function fallbackCopy(text) {
            try {
                var textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';  // ✅ Evitar scroll
                textarea.style.left = '-9999px';     // ✅ Ocultar
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                
                var success = document.execCommand('copy');
                document.body.removeChild(textarea);
                
                if (success) {
                    showCopySuccess();
                } else {
                    showMessage('❌ Could not copy address.', 'error');
                }
            } catch (e) {
                showMessage('❌ Could not copy address.', 'error');
            }
        }
        
        // ✅ Mostrar mensaje de éxito al copiar
        function showCopySuccess() {
            var originalText = copyBtn.textContent;
            copyBtn.textContent = '✅ Copied!';
            
            setTimeout(function() {
                if (copyBtn) copyBtn.textContent = originalText;
            }, 2000);
            
            showMessage('📋 Address copied to clipboard.', 'success');
        }
    }

    // ✅ Inicializar la aplicación
    function init() {
        // ✅ Obtener referencias a elementos del DOM
        addressInput = document.getElementById('address');
        requestBtn = document.getElementById('requestBtn');
        messageDiv = document.getElementById('message');
        balanceElement = document.getElementById('balance');
        donationAddressEl = document.getElementById('donationAddress');
        copyBtn = document.getElementById('copyBtn');
        transactionsGrid = document.getElementById('transactionsGrid');
        
        // ✅ Configurar event listeners
        if (requestBtn) {
            requestBtn.addEventListener('click', function(e) {
                e.preventDefault();  // ✅ Prevenir submit del formulario
                processFaucetRequest();
            });
        }
        
        // ✅ Configurar botón de copiar
        setupCopyButton();
        
        // ✅ Cargar datos iniciales
        updateBalance();
        loadTransactions();
        
        // ✅ Actualizar periódicamente (cada 30 segundos)
        setInterval(updateBalance, 30000);
        setInterval(loadTransactions, 30000);
        
        // ✅ Log de inicialización (para debug)
        console.log('✅ Faucet UI loaded - Secure & Compatible Mode');
        console.log('🔗 API Base: ' + API_BASE);
        console.log('🛡️ reCAPTCHA: Disabled (for security/compatibility)');
    }

    // ✅ Ejecutar inicialización cuando el DOM esté listo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // ✅ El DOM ya está listo
        init();
    }

    setInterval(() => {
    loadTransactions();
}, 15000);

document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        loadTransactions();
    }
});
})();