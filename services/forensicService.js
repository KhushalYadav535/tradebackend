const db = require('../db');

async function detectImpossiblePerformance(userId) {
    const client = await db.getClient();
    try {
        // Fetch recent trades for this user
        const { rows: trades } = await client.query(
            `SELECT t.id, t.trade_type, t.quantity, t.price, t.total_value, t.script_id, t.created_at, 
                    s.current_price, s.name
             FROM trades t
             JOIN scripts s ON t.script_id = s.id
             WHERE t.user_id = $1 AND t.status = 'EXECUTED'
             ORDER BY t.created_at ASC`,
            [userId]
        );

        if (trades.length === 0) {
            return { 
                analyzed: 0, 
                riskScore: 0, 
                anomalies: [],
                message: 'No trades to analyze'
            };
        }

        let riskScore = 0;
        let anomalies = [];
        let maxWinStreak = 0;
        let currentStreak = 0;
        let profitableTrades = 0;

        // In a real PNL calculation we match BUY/SELL. 
        // For simple anomaly detection, we estimate PNL of a single executed trade
        // by comparing its executed price to the current market price.
        for (const trade of trades) {
            let isProfitable = false;
            if (trade.trade_type === 'BUY' && Number(trade.current_price) > Number(trade.price)) {
                isProfitable = true;
            } else if (trade.trade_type === 'SELL' && Number(trade.current_price) < Number(trade.price)) {
                isProfitable = true;
            }

            if (isProfitable) {
                currentStreak++;
                profitableTrades++;
                maxWinStreak = Math.max(maxWinStreak, currentStreak);
            } else {
                currentStreak = 0;
            }
        }

        const winRate = profitableTrades / trades.length;

        if (trades.length >= 20 && winRate > 0.90) {
            riskScore += 50;
            anomalies.push(`Impossibly high win rate: ${(winRate * 100).toFixed(1)}% over ${trades.length} trades`);
        }

        if (maxWinStreak >= 15) {
            riskScore += 40;
            anomalies.push(`Suspicious consecutive win streak: ${maxWinStreak} trades without a loss`);
        }

        // Check trade frequency
        if (trades.length >= 50) {
            const timeSpanMs = new Date(trades[trades.length - 1].created_at) - new Date(trades[0].created_at);
            const timeSpanMinutes = timeSpanMs / (1000 * 60);
            const tradesPerMinute = trades.length / timeSpanMinutes;
            if (tradesPerMinute > 30) {
                riskScore += 30;
                anomalies.push(`High frequency trading detected: ${tradesPerMinute.toFixed(1)} trades/min`);
            }
        }

        return {
            analyzed: trades.length,
            winRate: Number((winRate * 100).toFixed(2)),
            maxWinStreak,
            riskScore,
            anomalies
        };
    } catch (err) {
        console.error('Error in detectImpossiblePerformance:', err);
        throw err;
    } finally {
        client.release();
    }
}

async function replayUserTransactions(userId) {
    const client = await db.getClient();
    try {
        const { rows: ledgerEntries } = await client.query(
            `SELECT description, debit, credit, balance, created_at 
             FROM ledger 
             WHERE user_id = $1 
             ORDER BY id ASC`,
            [userId]
        );

        let calculatedBalance = 0.00; // Start at 0, first entry is Opening Balance
        let discrepancies = [];

        for (const entry of ledgerEntries) {
            calculatedBalance += Number(entry.credit) - Number(entry.debit);
            
            // Compare calculated balance with the stored snapshot at that time
            const expected = calculatedBalance.toFixed(2);
            const actual = Number(entry.balance).toFixed(2);

            if (Math.abs(calculatedBalance - Number(entry.balance)) > 0.05) {
                discrepancies.push({
                    time: entry.created_at,
                    description: entry.description,
                    expected,
                    actual
                });
                // For continuing simulation, snap to what was stored to avoid cascading errors
                calculatedBalance = Number(entry.balance);
            }
        }

        // Get current user balance
        const { rows: userRows } = await client.query('SELECT balance FROM users WHERE id = $1', [userId]);
        const currentStoredBalance = userRows.length > 0 ? Number(userRows[0].balance).toFixed(2) : 0;
        
        if (Math.abs(calculatedBalance - Number(currentStoredBalance)) > 0.05) {
             discrepancies.push({
                 time: new Date(),
                 description: 'Final Balance Check',
                 expected: calculatedBalance.toFixed(2),
                 actual: currentStoredBalance
             });
        }

        return {
            startingBalance: ledgerEntries.length > 0 ? Number(ledgerEntries[0].credit) : 0,
            calculatedFinalBalance: calculatedBalance.toFixed(2),
            storedFinalBalance: currentStoredBalance,
            isClean: discrepancies.length === 0,
            discrepancies
        };
    } catch (err) {
        console.error('Error in replayUserTransactions:', err);
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    detectImpossiblePerformance,
    replayUserTransactions
};
