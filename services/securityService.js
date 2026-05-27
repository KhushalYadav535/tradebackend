const crypto = require('crypto');
const db = require('../db');

// Generate hash for a transaction
function generateTransactionHash(trade, previousHash = '0000000000000000') {
    const dataString = JSON.stringify({
        userId: trade.user_id,
        type: trade.trade_type,
        symbol: trade.script_id,
        quantity: trade.quantity,
        price: trade.price,
        timestamp: trade.created_at,
        previousHash: previousHash
    });
    
    return crypto
        .createHash('sha256')
        .update(dataString)
        .digest('hex');
}

// Get server private key or generate one if not exists
// In production, this should be stored securely (e.g., AWS KMS, or .env)
let SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY;
let SERVER_PUBLIC_KEY = process.env.SERVER_PUBLIC_KEY;

if (!SERVER_PRIVATE_KEY || !SERVER_PUBLIC_KEY) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });
    SERVER_PRIVATE_KEY = privateKey;
    SERVER_PUBLIC_KEY = publicKey;
    // Note: If the server restarts, this generates a new key pair.
    // In a real system, you would persist this key pair.
    console.log('Generated ephemeral Server RSA Key Pair for digital signatures.');
}

function signOrder(orderData) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(JSON.stringify(orderData));
    return sign.sign(SERVER_PRIVATE_KEY, 'hex');
}

function verifyOrderSignature(orderData, signature) {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(JSON.stringify(orderData));
    return verify.verify(SERVER_PUBLIC_KEY, signature, 'hex');
}

// Integrity Check Job
async function runPortfolioIntegrityCheck() {
    try {
        console.log('Running Portfolio Integrity Check...');
        const client = await db.getClient();
        try {
            const { rows: users } = await client.query('SELECT id, balance FROM users WHERE is_active = true');
            
            for (const user of users) {
                // Calculate cash from ledger (source of truth)
                const ledgerRes = await client.query(
                    `SELECT 
                        (SELECT 500000.00) + -- starting balance
                        COALESCE(SUM(credit - debit), 0) as cash_balance
                     FROM ledger
                     WHERE user_id = $1`,
                    [user.id]
                );
                
                const calculatedBalance = Number(ledgerRes.rows[0].cash_balance).toFixed(2);
                const storedBalance = Number(user.balance).toFixed(2);
                
                if (calculatedBalance !== storedBalance) {
                    console.error(`[SECURITY ALERT] Portfolio tampering detected for user ${user.id}. Calculated: ${calculatedBalance}, Stored: ${storedBalance}`);
                    // Suspend account or alert admin in real scenario
                    // await client.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
                }
            }
            console.log('Portfolio Integrity Check completed successfully.');
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error running integrity check:', err);
    }
}

module.exports = {
    generateTransactionHash,
    signOrder,
    verifyOrderSignature,
    runPortfolioIntegrityCheck
};
