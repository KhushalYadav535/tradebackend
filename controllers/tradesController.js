const db = require('../db');
const securityService = require('../services/securityService');
const vedpragya = require('../services/vedpragyaService');

async function logRejection(client, userId, scriptId, type, qty, price, reason) {
  await client.query(
    `INSERT INTO trades (user_id, script_id, trade_type, quantity, price, total_value, status, reject_reason)
     VALUES ($1,$2,$3,$4,$5,$6,'REJECTED',$7)`,
    [userId, scriptId, type, qty, price, Number(price) * Number(qty), reason]
  );
}

exports.place = async (req, res) => {
  const userId = req.user.id;
  const {
    script_id,
    trade_type,
    lots,
    quantity,
    price,
    order_type = 'MARKET',
    product_type = 'INTRADAY',
    nonce,
    timestamp
  } = req.body || {};

  if (!script_id || !trade_type || (!lots && !quantity)) {
    return res.status(400).json({ error: 'script_id, trade_type and lots/quantity are required' });
  }
  const type = String(trade_type).toUpperCase();
  if (type !== 'BUY' && type !== 'SELL') {
    return res.status(400).json({ error: 'trade_type must be BUY or SELL' });
  }

  if (!nonce || !timestamp) {
    return res.status(400).json({ error: 'Security headers (nonce, timestamp) are missing' });
  }
  
  // Check timestamp (prevent replay, within 60 seconds)
  const age = Date.now() - timestamp;
  if (age > 60000 || age < -60000) {
    return res.status(400).json({ error: 'Request expired or invalid timestamp' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // --- Maintenance mode check ---
    const maintRes = await client.query(`SELECT value FROM settings WHERE key='maintenance_mode'`);
    const maintenanceMode = maintRes.rows.length > 0 ? maintRes.rows[0].value : false;
    if (maintenanceMode === true || maintenanceMode === 'true') {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Platform is under maintenance. Trading is temporarily suspended.' });
    }

    // Idempotency check
    const idempotencyRes = await client.query(
      'INSERT INTO idempotency_keys (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key',
      [nonce]
    );
    if (idempotencyRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Duplicate request (replay attack detected)' });
    }

    const scriptRes = await client.query('SELECT * FROM scripts WHERE id=$1', [script_id]);
    if (scriptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Script not found' });
    }
    const script = scriptRes.rows[0];

    const userRes = await client.query('SELECT id, balance, exposure, auto_cut, auto_cut_limit FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const user = userRes.rows[0];

    const numLots = lots ? Number(lots) : Math.ceil(Number(quantity) / script.lot_size);
    const qty = numLots * script.lot_size;
    const execPrice = Number(price) || Number(script.current_price);
    const totalValue = Number((execPrice * qty).toFixed(2));
    const marginRequired = Number(script.margin_per_lot) * numLots;

    // --- Auto-cut limit check ---
    if (user.auto_cut && user.auto_cut_limit) {
      const usedRes = await client.query(
        `SELECT COALESCE(SUM(total_value), 0)::numeric AS used
         FROM trades
         WHERE user_id=$1 AND status='EXECUTED' AND created_at::date = CURRENT_DATE`,
        [userId]
      );
      const used = Number(usedRes.rows[0].used);
      if (used + totalValue > Number(user.auto_cut_limit)) {
        const reason = `Auto-cut limit reached. Daily limit: ₹${Number(user.auto_cut_limit).toLocaleString('en-IN')} | Already traded: ₹${used.toLocaleString('en-IN')}`;
        await logRejection(client, userId, script.id, type, qty, execPrice, reason);
        await client.query('COMMIT');
        return res.status(400).json({ error: reason });
      }
    }

    // 0. Price validation (prevent manipulation)
    // Use live Vedpragya price as the reference — NOT stale DB current_price.
    // This prevents false rejections when VP stream sends live bid/ask prices
    // that differ from the stale DB value by >5%.
    let refPrice = Number(script.current_price);
    try {
      const vpLtp = await vedpragya.getLtp(script.name, script.exchange || null);
      if (vpLtp && vpLtp > 0) {
        refPrice = vpLtp;
        // Update DB price silently (fire-and-forget)
        db.query('UPDATE scripts SET current_price=$1 WHERE id=$2', [vpLtp, script.id]).catch(() => {});
      }
    } catch { /* fall through — use DB price */ }

    if (refPrice > 0) {
      const priceDeviation = Math.abs(execPrice - refPrice) / refPrice;
      if (priceDeviation > 0.10) {  // 10% threshold — accounts for VP polling lag
        const reason = `Price deviation too high (requested: ${execPrice}, market: ${refPrice.toFixed(2)})`;
        await logRejection(client, userId, script.id, type, qty, execPrice, reason);
        await client.query('COMMIT');
        return res.status(400).json({ error: reason });
      }
    }

    // 1. Banned script
    if (script.is_banned) {
      const reason = `Script banned: ${script.ban_reason || 'restricted'}`;
      await logRejection(client, userId, script.id, type, qty, execPrice, reason);
      await client.query('COMMIT');
      return res.status(400).json({ error: reason });
    }

    // 2. Quantity limit
    if (numLots > script.max_lots) {
      const reason = `Lots ${numLots} exceeds max ${script.max_lots}`;
      await logRejection(client, userId, script.id, type, qty, execPrice, reason);
      await client.query('COMMIT');
      return res.status(400).json({ error: reason });
    }

    // 3. Margin
    if (Number(user.balance) < marginRequired) {
      const reason = `Insufficient margin (required ${marginRequired}, available ${user.balance})`;
      await logRejection(client, userId, script.id, type, qty, execPrice, reason);
      await client.query('COMMIT');
      return res.status(400).json({ error: reason });
    }

    // 4. Insert trade EXECUTED
    // First fetch last trade for hash chaining
    const lastTradeRes = await client.query(
      'SELECT current_hash FROM trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    const previousHash = lastTradeRes.rows.length > 0 ? lastTradeRes.rows[0].current_hash : '0000000000000000';
    
    // Create a mock trade object to generate hash
    const mockTrade = {
      user_id: userId,
      trade_type: type,
      script_id: script.id,
      quantity: qty,
      price: execPrice,
      created_at: new Date() // approximate timestamp for hash
    };
    
    const currentHash = securityService.generateTransactionHash(mockTrade, previousHash);
    const signature = securityService.signOrder({
      ...mockTrade,
      currentHash,
      nonce
    });

    const tradeRes = await client.query(
      `INSERT INTO trades (user_id, script_id, trade_type, quantity, price, total_value, order_type, product_type, status, previous_hash, current_hash, signature, nonce)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'EXECUTED',$9,$10,$11,$12) RETURNING id, created_at`,
      [userId, script.id, type, qty, execPrice, totalValue, order_type, product_type, previousHash, currentHash, signature, nonce]
    );
    const tradeId = tradeRes.rows[0].id;

    // 5. Position upsert with weighted-average price
    const existing = await client.query(
      'SELECT * FROM positions WHERE user_id=$1 AND script_id=$2 FOR UPDATE',
      [userId, script.id]
    );

    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO positions (user_id, script_id, buy_qty, sell_qty, avg_buy_price, avg_sell_price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          userId,
          script.id,
          type === 'BUY' ? qty : 0,
          type === 'SELL' ? qty : 0,
          type === 'BUY' ? execPrice : null,
          type === 'SELL' ? execPrice : null,
        ]
      );
    } else {
      const p = existing.rows[0];
      let { buy_qty, sell_qty, avg_buy_price, avg_sell_price } = p;
      buy_qty = Number(buy_qty); sell_qty = Number(sell_qty);
      avg_buy_price = avg_buy_price ? Number(avg_buy_price) : 0;
      avg_sell_price = avg_sell_price ? Number(avg_sell_price) : 0;

      if (type === 'BUY') {
        const newQty = buy_qty + qty;
        avg_buy_price = newQty ? ((avg_buy_price * buy_qty) + (execPrice * qty)) / newQty : 0;
        buy_qty = newQty;
      } else {
        const newQty = sell_qty + qty;
        avg_sell_price = newQty ? ((avg_sell_price * sell_qty) + (execPrice * qty)) / newQty : 0;
        sell_qty = newQty;
      }

      await client.query(
        `UPDATE positions
         SET buy_qty=$1, sell_qty=$2, avg_buy_price=$3, avg_sell_price=$4, updated_at=NOW()
         WHERE id=$5`,
        [buy_qty, sell_qty, avg_buy_price || null, avg_sell_price || null, p.id]
      );
    }

    // 6. Balance + exposure (margin held while position is open)
    const balanceDelta = type === 'BUY' ? -marginRequired : marginRequired;
    const exposureDelta = type === 'BUY' ? marginRequired : -marginRequired;
    const newBalance = Number(user.balance) + balanceDelta;
    const newExposure = Number(user.exposure) + exposureDelta;

    await client.query(
      'UPDATE users SET balance=$1, exposure=$2 WHERE id=$3',
      [newBalance, newExposure, userId]
    );

    // 7. Ledger entry
    const desc = `${type} ${numLots} lot(s) ${script.name} @ ${execPrice}`;
    await client.query(
      `INSERT INTO ledger (user_id, description, debit, credit, balance, trade_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        userId,
        desc,
        type === 'BUY' ? marginRequired : 0,
        type === 'SELL' ? marginRequired : 0,
        newBalance,
        tradeId,
      ]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      trade: {
        id: tradeId,
        script: script.name,
        trade_type: type,
        quantity: qty,
        lots: numLots,
        price: execPrice,
        total_value: totalValue,
        margin: marginRequired,
      },
      balance: newBalance,
      exposure: newExposure,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('trade.place', err);
    res.status(500).json({ error: 'Failed to place trade' });
  } finally {
    client.release();
  }
};

exports.list = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.trade_type, t.quantity, t.price, t.total_value, t.order_type,
              t.product_type, t.status, t.reject_reason, t.created_at,
              s.name AS script, s.exchange
       FROM trades t
       JOIN scripts s ON s.id = t.script_id
       WHERE t.user_id = $1 AND t.created_at::date = CURRENT_DATE
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );
    res.json({ trades: rows });
  } catch (err) {
    console.error('trade.list', err);
    res.status(500).json({ error: 'Failed to load trades' });
  }
};

exports.editLog = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.trade_id, l.action, l.old_values, l.new_values, l.created_at,
              u.username AS done_by,
              s.name AS script
       FROM trade_logs l
       LEFT JOIN users u ON u.id = l.done_by
       LEFT JOIN trades t ON t.id = l.trade_id
       LEFT JOIN scripts s ON s.id = t.script_id
       WHERE l.user_id = $1
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json({ logs: rows });
  } catch (err) {
    console.error('trade.editLog', err);
    res.status(500).json({ error: 'Failed to load edit log' });
  }
};

exports.rejectionLog = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.trade_type, t.quantity, t.price, t.reject_reason, t.created_at,
              s.name AS script, s.exchange
       FROM trades t
       JOIN scripts s ON s.id = t.script_id
       WHERE t.user_id = $1 AND t.status = 'REJECTED'
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );
    res.json({ trades: rows });
  } catch (err) {
    console.error('trade.rejectionLog', err);
    res.status(500).json({ error: 'Failed to load rejection log' });
  }
};
