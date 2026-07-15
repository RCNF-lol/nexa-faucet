/**
 * 🔐 faucet/script.js - Versión Segura y Compatible
 */
(function() {
    'use strict';

    var API_BASE = 'https://nexa-faucet-kub8.onrender.com';
    
    var addressInput = null;
    var requestBtn = null;
    var messageDiv = null;
    var balanceElement = null;
    var donationAddressEl = null;
    var copyBtn = null;
    var transactionsGrid = null;

    function showMessage(text, type) {
        if (!messageDiv) return;
        var safeText = text.replace(/[<>]/g, '');
        messageDiv.textContent = safeText;
        messageDiv.className = 'message ' + type;
        messageDiv.style.display = 'block';
        setTimeout(function() {
            if (messageDiv) messageDiv.style.display = 'none';
        }, 8000);
    }

    function isValidNexaAddress(address) {
        if (!address || typeof address !== 'string') return false;
        return /^nexa:[a-zA-Z0-9]{20,}$/i.test(address);
    }

    function safeFetch(url, method, body) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Accept', 'application/json');
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
                reject(new Error('Connection failed. Please check your internet or try later.'));
            };
            
            xhr.ontimeout = function() {
                reject(new Error('Request timed out. Please try again.'));
            };
            
            xhr.send(body ? JSON.stringify(body) : null);
        });
    }

    function processFaucetRequest() {
        var address = addressInput ? addressInput.value.trim() : '';
        if (!address) return showMessage('⚠️ Please enter a Nexa address.', 'error');
        if (!isValidNexaAddress(address)) return showMessage('⚠️ Invalid Nexa address.', 'error');

        if (requestBtn) {
            requestBtn.disabled = true;
            requestBtn.innerHTML = '<span class="loader"></span> Sending...';
        }
        
        safeFetch(API_BASE + '/faucet', 'POST', { address: address })
            .then(function(data) {
                if (data && data.success) {
                    var amount = data.amount ? (data.amount / 100).toFixed(2) : '10000.00';
                    var shortTxid = data.txid ? data.txid.substring(0, 12) + '...' : 'N/A';
                    showMessage('✅ Sent ' + amount + ' NEXA! TX: ' + shortTxid, 'success');
                    if (addressInput) addressInput.value = '';
                    setTimeout(updateBalance, 2000);
                } else {
                    throw new Error(data && data.error ? data.error : 'Unknown error');
                }
            })
            .catch(function(error) {
                console.error('❌ Faucet error:', error.message);
                var errorMsg = error.message;
                if (errorMsg.indexOf('429') !== -1) {
                    showMessage('⏰ You\'ve already claimed funds. Please wait 24 hours.', 'error');
                } else if (errorMsg.indexOf('500') !== -1 || errorMsg.indexOf('insufficient') !== -1) {
                    showMessage('❌ Faucet has insufficient funds.', 'error');
                } else {
                    showMessage('❌ ' + errorMsg, 'error');
                }
            })
            .finally(function() {
                if (requestBtn) {
                    requestBtn.disabled = false;
                    requestBtn.textContent = 'Claim 10000 NEXA';
                }
            });
    }

    function updateBalance() {
        if (!balanceElement) return;
        balanceElement.textContent = 'Loading...';
        
        safeFetch(API_BASE + '/balance', 'GET', null)
            .then(function(data) {
                if (data && data.success && data.balanceInNEXA !== undefined) {
                    balanceElement.innerHTML = '<strong>' + data.balanceInNEXA + '</strong> NEXA';
                    if (data.address && donationAddressEl) {
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

    function timeAgo(ts) {
        if (!ts) return 'N/A';
        var seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
        if (seconds < 60) return seconds + ' sec ago';
        if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
        return Math.floor(seconds / 86400) + ' d ago';
    }

    function loadTransactions() {
        if (!transactionsGrid) return;
        transactionsGrid.innerHTML = '<p style="text-align:center;color:#aaa">Loading...</p>';

        safeFetch(API_BASE + '/transactions', 'GET', null)
            .then(function(data) {
                if (data && data.success && Array.isArray(data.transactions) && data.transactions.length > 0) {
                    transactionsGrid.innerHTML = '';
                    var limit = Math.min(data.transactions.length, 6);
                    for (var i = 0; i < limit; i++) {
                        var tx = data.transactions[i];
                        var card = document.createElement('div');
                        card.className = 'transaction-card';

                        var addr = (tx.shortAddress || 'Unknown').replace(/[<>]/g, '');
                        var hash = (tx.hash || 'N/A').replace(/[<>]/g, '');
                        var amount = (tx.amount || '0').replace(/[<>]/g, '');
                        var ago = timeAgo(tx.timestamp);

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

    function setupCopyButton() {
        if (!copyBtn || !donationAddressEl) return;
        copyBtn.addEventListener('click', function() {
            var code = donationAddressEl.querySelector('code');
            var addr = code ? code.textContent.trim() : '';
            if (!addr || addr === 'Loading...') return showMessage('⚠️ Address not available.', 'error');
            
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(addr).then(showCopySuccess).catch(fallbackCopy.bind(null, addr));
            } else {
                fallbackCopy(addr);
            }
        });
        
        function fallbackCopy(text) {
            try {
                var textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                var success = document.execCommand('copy');
                document.body.removeChild(textarea);
                if (success) showCopySuccess();
                else showMessage('❌ Could not copy address.', 'error');
            } catch (e) {
                showMessage('❌ Could not copy address.', 'error');
            }
        }
        
        function showCopySuccess() {
            var originalText = copyBtn.textContent;
            copyBtn.textContent = '✅ Copied!';
            setTimeout(function() { if (copyBtn) copyBtn.textContent = originalText; }, 2000);
            showMessage('📋 Address copied to clipboard.', 'success');
        }
    }

    function init() {
        addressInput = document.getElementById('address');
        requestBtn = document.getElementById('requestBtn');
        messageDiv = document.getElementById('message');
        balanceElement = document.getElementById('balance');
        donationAddressEl = document.getElementById('donationAddress');
        copyBtn = document.getElementById('copyBtn');
        transactionsGrid = document.getElementById('transactionsGrid');
        
        if (requestBtn) {
            requestBtn.addEventListener('click', function(e) {
                e.preventDefault();
                processFaucetRequest();
            });
        }
        
        setupCopyButton();
        updateBalance();
        loadTransactions();
        
        setInterval(updateBalance, 30000);
        setInterval(loadTransactions, 30000);
        
        console.log('✅ Faucet UI loaded - Secure & Compatible Mode');
        console.log('🔗 API Base: ' + API_BASE);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) loadTransactions();
    });
})();
