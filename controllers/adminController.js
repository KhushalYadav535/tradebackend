const bcrypt = require('bcryptjs');
const db = require('../db');

exports.stats = async (req, res) => {
  try {
    const [users, trades, ledger, scripts] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE is_active)::int AS active,
                       COALESCE(SUM(balance), 0)::numeric AS total_balance
                FROM users WHERE role = 'user'`),
      db.query(`SELECT COUNT(*)::int AS trades_today
                FROM trades WHERE created_at::date = CURRENT_DATE AND status = 'EXECUTED'`),
      db.query(`SELECT COALESCE(SUM(credit) - SUM(debit), 0)::numeric AS net
                FROM ledger`),
      db.query(`SELECT COUNT(*)::int AS total_scripts,
                       COUNT(*) FILTER (WHERE is_banned)::int AS banned
                FROM scripts`),
    ]);
    res.json({
      students: users.rows[0],
      trades_today: trades.rows[0].trades_today,
      net_pnl: Number(ledger.rows[0].net),
      scripts: scripts.rows[0],
    });
  } catch (err) {
    console.error('admin.stats', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
};

exports.listStudents = async (req, res) => {
  try {
    const { role } = req.query; // ?role=user|master|broker|admin
    let whereClause = '';
    const params = [];
    if (role) {
      params.push(role);
      whereClause = `WHERE u.role = $1`;
    }
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.full_name, u.balance, u.exposure, u.is_active, u.role,
              u.brokerage_type, u.brokerage_value, u.auto_cut, u.auto_cut_limit, u.created_at,
              u.phone, u.city, u.master_id, u.broker_id, u.commission_pct,
              (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id AND t.status='EXECUTED')::int AS trade_count,
              m.username AS master_name, b.username AS broker_name
       FROM users u
       LEFT JOIN users m ON m.id = u.master_id
       LEFT JOIN users b ON b.id = u.broker_id
       ${whereClause}
       ORDER BY u.created_at DESC`,
      params
    );
    res.json({ students: rows });
  } catch (err) {
    console.error('admin.listStudents', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
};

/* ── Master Listing — with sub-counts + parent ───────────────────────────────── */
exports.listMasters = async (req, res) => {
  try {
    const { status, join_after, join_before } = req.query;
    const params = [];
    let filters = '';
    if (status === 'active')   filters += ' AND u.is_active = true';
    if (status === 'inactive') filters += ' AND u.is_active = false';
    if (join_after)  { params.push(new Date(join_after).toISOString());  filters += ` AND u.created_at >= $${params.length}`; }
    if (join_before) { const e = new Date(join_before); e.setHours(23,59,59,999); params.push(e.toISOString()); filters += ` AND u.created_at <= $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        u.id, u.username, u.full_name, u.is_active, u.role,
        u.commission_pct, u.created_at,
        u.phone, u.city, u.master_id, u.broker_id,
        u.brokerage_type, u.brokerage_value, u.balance, u.exposure,
        parent.username AS parent_name,
        (SELECT COUNT(*) FROM users s WHERE s.master_id = u.id AND s.role = 'master')::int  AS masters_u,
        (SELECT COUNT(*) FROM users s WHERE s.master_id = u.id AND s.role = 'user')::int    AS users_u,
        (SELECT COUNT(*) FROM users s WHERE s.master_id = u.id AND s.role = 'broker')::int  AS brokers_u
      FROM users u
      LEFT JOIN users parent ON parent.id = u.master_id
      WHERE u.role = 'master' ${filters}
      ORDER BY u.created_at DESC
    `, params);

    res.json({ masters: rows });
  } catch (err) {
    console.error('admin.listMasters', err);
    res.status(500).json({ error: 'Failed to load masters' });
  }
};

/* ── Broker Listing — with sub-counts + parent ───────────────────────────────── */
exports.listBrokers = async (req, res) => {
  try {
    const { status, join_after, join_before } = req.query;
    const params = [];
    let filters = '';
    if (status === 'active')   filters += ' AND u.is_active = true';
    if (status === 'inactive') filters += ' AND u.is_active = false';
    if (join_after)  { params.push(new Date(join_after).toISOString());  filters += ` AND u.created_at >= $${params.length}`; }
    if (join_before) { const e = new Date(join_before); e.setHours(23,59,59,999); params.push(e.toISOString()); filters += ` AND u.created_at <= $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        u.id, u.username, u.full_name, u.is_active, u.role,
        u.commission_pct, u.created_at,
        u.phone, u.city, u.master_id, u.broker_id,
        u.brokerage_type, u.brokerage_value, u.balance, u.exposure,
        -- Master name (broker's own master)
        m.username AS master_name,
        m.id       AS master_id_val,
        -- Total users directly under this broker
        (SELECT COUNT(*) FROM users s WHERE s.broker_id = u.id AND s.role = 'user')::int AS total_users,
        -- Outstanding = sum of open position values for all users under this broker
        COALESCE((
          SELECT SUM(ABS(t.quantity * t.price))
          FROM trades t
          JOIN users su ON su.id = t.user_id
          WHERE su.broker_id = u.id
            AND t.status = 'EXECUTED'
            AND NOT EXISTS (
              SELECT 1 FROM trades t2
              WHERE t2.user_id = t.user_id
                AND t2.script_id = t.script_id
                AND t2.status = 'EXECUTED'
                AND t2.id > t.id
                AND t2.trade_type != t.trade_type
            )
        ), 0)::numeric AS outstanding,
        -- Live brokerage = total brokerage collected from users under this broker
        COALESCE((
          SELECT SUM(
            CASE
              WHEN su.brokerage_type = 'per_lot' THEN su.brokerage_value * t.quantity
              WHEN su.brokerage_type = 'per_crore' THEN su.brokerage_value * (t.quantity * t.price) / 10000000
              ELSE 0
            END
          )
          FROM trades t
          JOIN users su ON su.id = t.user_id
          WHERE su.broker_id = u.id AND t.status = 'EXECUTED'
        ), 0)::numeric AS live_brokerage
      FROM users u
      LEFT JOIN users m ON m.id = u.master_id
      WHERE u.role = 'broker' ${filters}
      ORDER BY u.created_at DESC
    `, params);

    res.json({ brokers: rows });
  } catch (err) {
    console.error('admin.listBrokers', err);
    res.status(500).json({ error: 'Failed to load brokers' });
  }
};


exports.createStudent = async (req, res) => {

  const {
    username, password, full_name, balance,
    brokerage_type, brokerage_value, auto_cut, auto_cut_limit,
    role: accountRole, master_id, broker_id, phone, city, commission_pct,
  } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-50 chars, letters/digits/_.-' });
  }
  const brokerageType = ['per_lot', 'per_crore'].includes(brokerage_type) ? brokerage_type : 'per_lot';
  const brokerageVal  = Number(brokerage_value) >= 0 ? Number(brokerage_value) : 0;
  const autoCut       = auto_cut === true || auto_cut === 'true';
  const autoCutLimit  = autoCut && Number(auto_cut_limit) > 0 ? Number(auto_cut_limit) : null;
  const userRole      = ['user', 'master', 'broker', 'admin'].includes(accountRole) ? accountRole : 'user';
  const masterId      = master_id ? Number(master_id) : null;
  const brokerId      = broker_id ? Number(broker_id) : null;
  const commissionPct = commission_pct ? Number(commission_pct) : null;

  try {
    const exists = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, 10);
    const initialBalance = Number(balance) > 0 ? Number(balance) : 500000;
    const { rows } = await db.query(
      `INSERT INTO users
         (username, password_hash, full_name, role, balance, brokerage_type, brokerage_value,
          auto_cut, auto_cut_limit, master_id, broker_id, phone, city, commission_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, username, full_name, role, balance, exposure, is_active,
                 brokerage_type, brokerage_value, auto_cut, auto_cut_limit,
                 master_id, broker_id, phone, city, commission_pct, created_at`,
      [username, hash, full_name || username, userRole, initialBalance,
       brokerageType, brokerageVal, autoCut, autoCutLimit,
       masterId, brokerId, phone || null, city || null, commissionPct]
    );
    const student = rows[0];
    await db.query(
      `INSERT INTO ledger (user_id, description, credit, balance)
       VALUES ($1, 'Opening Balance (admin-created)', $2, $2)`,
      [student.id, initialBalance]
    );
    res.json({ student: { ...student, password } });
  } catch (err) {
    console.error('admin.createStudent', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
};


exports.updateStudent = async (req, res) => {
  const id = Number(req.params.id);
  const { full_name, balance, is_active, password, role, brokerage_type, brokerage_value, auto_cut, auto_cut_limit } = req.body || {};
  try {
    const cur = await db.query(`SELECT * FROM users WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Student not found' });

    const sets = [];
    const vals = [];
    let i = 1;

    if (typeof full_name === 'string') { sets.push(`full_name=$${i++}`); vals.push(full_name); }
    if (typeof is_active === 'boolean') { sets.push(`is_active=$${i++}`); vals.push(is_active); }
    if (typeof role === 'string' && ['user', 'admin'].includes(role)) { sets.push(`role=$${i++}`); vals.push(role); }
    if (balance !== undefined && balance !== null && !Number.isNaN(Number(balance))) {
      sets.push(`balance=$${i++}`); vals.push(Number(balance));
    }
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const hash = await bcrypt.hash(password, 10);
      sets.push(`password_hash=$${i++}`); vals.push(hash);
    }
    if (brokerage_type !== undefined && ['per_lot', 'per_crore'].includes(brokerage_type)) {
      sets.push(`brokerage_type=$${i++}`); vals.push(brokerage_type);
    }
    if (brokerage_value !== undefined && !Number.isNaN(Number(brokerage_value))) {
      sets.push(`brokerage_value=$${i++}`); vals.push(Number(brokerage_value));
    }
    if (auto_cut !== undefined) {
      const autoCutBool = auto_cut === true || auto_cut === 'true';
      sets.push(`auto_cut=$${i++}`); vals.push(autoCutBool);
      // Update auto_cut_limit together
      if (autoCutBool && auto_cut_limit !== undefined && Number(auto_cut_limit) > 0) {
        sets.push(`auto_cut_limit=$${i++}`); vals.push(Number(auto_cut_limit));
      } else if (!autoCutBool) {
        sets.push(`auto_cut_limit=$${i++}`); vals.push(null);
      }
    } else if (auto_cut_limit !== undefined && !Number.isNaN(Number(auto_cut_limit))) {
      sets.push(`auto_cut_limit=$${i++}`); vals.push(Number(auto_cut_limit) > 0 ? Number(auto_cut_limit) : null);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id=$${i}
       RETURNING id, username, full_name, balance, exposure, is_active, brokerage_type, brokerage_value, auto_cut, auto_cut_limit`,
      vals
    );

    if (balance !== undefined && balance !== null && !Number.isNaN(Number(balance))) {
      const delta = Number(balance) - Number(cur.rows[0].balance);
      if (delta !== 0) {
        await db.query(
          `INSERT INTO ledger (user_id, description, debit, credit, balance)
           VALUES ($1, 'Admin balance adjustment', $2, $3, $4)`,
          [id, delta < 0 ? Math.abs(delta) : 0, delta > 0 ? delta : 0, Number(balance)]
        );
      }
    }

    res.json({ student: rows[0] });
  } catch (err) {
    console.error('admin.updateStudent', err);
    res.status(500).json({ error: 'Failed to update student' });
  }
};

exports.creditStudent = async (req, res) => {
  const id = Number(req.params.id);
  const { amount, description } = req.body || {};
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  try {
    const cur = await db.query(`SELECT id, balance FROM users WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Student not found' });
    const currentBalance = Number(cur.rows[0].balance);
    const creditAmount = Number(amount);
    const newBalance = currentBalance + creditAmount;
    await db.query(`UPDATE users SET balance=$1 WHERE id=$2`, [newBalance, id]);
    await db.query(
      `INSERT INTO ledger (user_id, description, credit, balance)
       VALUES ($1, $2, $3, $4)`,
      [id, description || 'Admin credit', creditAmount, newBalance]
    );
    res.json({ ok: true, new_balance: newBalance, credited: creditAmount });
  } catch (err) {
    console.error('admin.creditStudent', err);
    res.status(500).json({ error: 'Failed to credit student' });
  }
};

exports.deleteStudent = async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await db.query(`DELETE FROM users WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Student not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('admin.deleteStudent', err);
    res.status(500).json({ error: 'Failed to delete student' });
  }
};

exports.studentTrades = async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.trade_type, t.quantity, t.price, t.total_value, t.status, t.reject_reason, t.created_at,
              s.name AS script, s.exchange
       FROM trades t
       JOIN scripts s ON s.id = t.script_id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC
       LIMIT 200`,
      [id]
    );
    res.json({ trades: rows });
  } catch (err) {
    console.error('admin.studentTrades', err);
    res.status(500).json({ error: 'Failed to load trades' });
  }
};

exports.getAllTrades = async (req, res) => {
  try {
    const { status, trade_after, trade_before, exchange, script, broker_id, master_id, user_id, order_type } = req.query;

    const params = [];
    const wheres = ['1=1'];

    if (status)       { params.push(status.toUpperCase()); wheres.push(`t.status = $${params.length}`); }
    if (trade_after)  { params.push(new Date(trade_after).toISOString()); wheres.push(`t.created_at >= $${params.length}`); }
    if (trade_before) { const d = new Date(trade_before); d.setHours(23,59,59,999); params.push(d.toISOString()); wheres.push(`t.created_at <= $${params.length}`); }
    if (exchange)     { params.push(exchange); wheres.push(`s.exchange = $${params.length}`); }
    if (script)       { params.push(script); wheres.push(`s.name ILIKE $${params.length}`); }
    if (user_id)      { params.push(Number(user_id)); wheres.push(`t.user_id = $${params.length}`); }
    if (master_id)    { params.push(Number(master_id)); wheres.push(`u.master_id = $${params.length}`); }
    if (order_type)   { params.push(order_type.toUpperCase()); wheres.push(`t.trade_type = $${params.length}`); }

    const { rows } = await db.query(`
      SELECT t.id, t.trade_type, t.quantity, t.price, t.total_value,
             t.status, t.reject_reason, t.order_type, t.product_type, t.created_at,
             CASE WHEN s.lot_size > 0 THEN CEIL(t.quantity::numeric / s.lot_size) ELSE NULL END AS lots,
             s.name AS script, s.exchange, s.lot_size,
             u.id AS user_id, u.username, u.full_name,
             m.username AS master_username, m.full_name AS master_name,
             b.username AS broker_username
      FROM trades t
      JOIN scripts s ON s.id = t.script_id
      JOIN users u ON u.id = t.user_id
      LEFT JOIN users m ON m.id = u.master_id
      LEFT JOIN users b ON b.id = u.broker_id
      WHERE ${wheres.join(' AND ')}
      ORDER BY t.created_at DESC
      LIMIT 1000
    `, params);
    res.json({ trades: rows });
  } catch (err) {
    console.error('admin.getAllTrades', err);
    res.status(500).json({ error: 'Failed to load trades' });
  }
};

exports.cancelTrade = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `UPDATE trades SET status = 'REJECTED', reject_reason = 'Cancelled by admin', updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING' RETURNING id, status`,
      [Number(id)]
    );
    if (!rows.length) return res.status(400).json({ error: 'Trade not found or not PENDING' });
    res.json({ ok: true, trade: rows[0] });
  } catch (err) {
    console.error('admin.cancelTrade', err);
    res.status(500).json({ error: 'Failed to cancel trade' });
  }
};


exports.getRejections = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.trade_type, t.quantity, t.price, t.total_value, t.status, t.reject_reason, t.created_at,
             s.name AS script, s.exchange,
             u.username, u.full_name
      FROM trades t
      JOIN scripts s ON s.id = t.script_id
      JOIN users u ON u.id = t.user_id
      WHERE t.status = 'REJECTED'
      ORDER BY t.created_at DESC
      LIMIT 200
    `);
    res.json({ rejections: rows });
  } catch (err) {
    console.error('admin.getRejections', err);
    res.status(500).json({ error: 'Failed to load rejections' });
  }
};

exports.getSettings = async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT key, value FROM settings`);
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) {
    console.error('admin.getSettings', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
};

exports.updateSettings = async (req, res) => {
  const settings = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Invalid settings object' });
  }
  try {
    const keys = Object.keys(settings);
    for (const key of keys) {
      await db.query(`
        INSERT INTO settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [key, JSON.stringify(settings[key])]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('admin.updateSettings', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

exports.updateScriptLot = async (req, res) => {
  const id = Number(req.params.id);
  const { lot_size, max_lots, margin_per_lot, is_banned, ban_reason } = req.body;
  
  try {
    const { rows } = await db.query(`
      UPDATE scripts 
      SET lot_size = COALESCE($1, lot_size),
          max_lots = COALESCE($2, max_lots),
          margin_per_lot = COALESCE($3, margin_per_lot),
          is_banned = COALESCE($4, is_banned),
          ban_reason = COALESCE($5, ban_reason)
      WHERE id = $6
      RETURNING id, name, lot_size, max_lots, margin_per_lot, is_banned, ban_reason
    `, [lot_size, max_lots, margin_per_lot, is_banned, ban_reason, id]);
    
    if (!rows.length) return res.status(404).json({ error: 'Script not found' });
    res.json({ script: rows[0] });
  } catch (err) {
    console.error('admin.updateScriptLot', err);
    res.status(500).json({ error: 'Failed to update script' });
  }
};

exports.getOpsRevenue = async (req, res) => {
  try {
    const [stats, dailyTrades] = await Promise.all([
      db.query(`
        SELECT 
          (SELECT COALESCE(SUM(credit) - SUM(debit), 0) FROM ledger) AS net_pnl,
          (SELECT COUNT(*) FROM trades WHERE status='EXECUTED') AS total_trades,
          (SELECT COUNT(DISTINCT user_id) FROM positions WHERE buy_qty > 0 OR sell_qty > 0) AS active_users
      `),
      db.query(`
        SELECT created_at::date as date, COUNT(*) as trade_count
        FROM trades 
        WHERE status='EXECUTED' 
        GROUP BY created_at::date 
        ORDER BY created_at::date DESC 
        LIMIT 7
      `)
    ]);
    
    res.json({
      stats: stats.rows[0],
      dailyTrades: dailyTrades.rows
    });
  } catch (err) {
    console.error('admin.getOpsRevenue', err);
    res.status(500).json({ error: 'Failed to load ops stats' });
  }
};

exports.getPositions = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.buy_qty, p.sell_qty, p.avg_buy_price, p.avg_sell_price, p.updated_at,
             u.username, u.full_name,
             s.name as script, s.exchange, s.current_price
      FROM positions p
      JOIN users u ON u.id = p.user_id
      JOIN scripts s ON s.id = p.script_id
      WHERE p.buy_qty > 0 OR p.sell_qty > 0
      ORDER BY p.updated_at DESC
    `);
    res.json({ positions: rows });
  } catch (err) {
    console.error('admin.getPositions', err);
    res.status(500).json({ error: 'Failed to load positions' });
  }
};

exports.getLedger = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT l.id, l.description, l.debit, l.credit, l.balance, l.created_at,
             u.username, u.full_name
      FROM ledger l
      JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC
      LIMIT 1000
    `);
    res.json({ ledger: rows });
  } catch (err) {
    console.error('admin.getLedger', err);
    res.status(500).json({ error: 'Failed to load ledger' });
  }
};

exports.getTradeLogs = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT tl.id, tl.action, tl.old_values, tl.new_values, tl.created_at,
             u.username as target_user, 
             dbu.username as done_by_user,
             s.name as script, t.trade_type
      FROM trade_logs tl
      LEFT JOIN users u ON u.id = tl.user_id
      LEFT JOIN users dbu ON dbu.id = tl.done_by
      LEFT JOIN trades t ON t.id = tl.trade_id
      LEFT JOIN scripts s ON s.id = t.script_id
      ORDER BY tl.created_at DESC
      LIMIT 1000
    `);
    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getTradeLogs', err);
    res.status(500).json({ error: 'Failed to load trade logs' });
  }
};

// Indices Master
exports.listIndices = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, display_name, is_active, created_at
      FROM indices
      ORDER BY created_at ASC
    `);
    res.json({ indices: rows });
  } catch (err) {
    console.error('admin.listIndices', err);
    res.status(500).json({ error: 'Failed to load indices' });
  }
};

exports.updateIndices = async (req, res) => {
  const { id, is_active } = req.body;
  
  if (!id || typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'id and is_active are required' });
  }
  
  try {
    const { rows } = await db.query(`
      UPDATE indices
      SET is_active = $1
      WHERE id = $2
      RETURNING id, name, display_name, is_active
    `, [is_active, id]);
    
    if (!rows.length) return res.status(404).json({ error: 'Index not found' });
    res.json({ index: rows[0] });
  } catch (err) {
    console.error('admin.updateIndices', err);
    res.status(500).json({ error: 'Failed to update index' });
  }
};

exports.createIndex = async (req, res) => {
  const { name, display_name } = req.body || {};
  if (!name || !display_name) {
    return res.status(400).json({ error: 'name and display_name are required' });
  }
  const cleanName = String(name).toUpperCase().trim();
  if (!/^[A-Z0-9_-]{1,30}$/.test(cleanName)) {
    return res.status(400).json({ error: 'Name must be uppercase letters/digits only (max 30 chars)' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO indices (name, display_name, is_active)
      VALUES ($1, $2, true)
      RETURNING id, name, display_name, is_active, created_at
    `, [cleanName, String(display_name).trim()]);
    res.json({ index: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `Index "${cleanName}" already exists` });
    }
    console.error('admin.createIndex', err);
    res.status(500).json({ error: 'Failed to create index' });
  }
};

exports.deleteIndex = async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await db.query(`DELETE FROM indices WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Index not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('admin.deleteIndex', err);
    res.status(500).json({ error: 'Failed to delete index' });
  }
};

// Script Master
exports.listScriptMaster = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, exchange, is_active, is_banned, current_price, lot_size, created_at
      FROM scripts
      ORDER BY exchange, name ASC
    `);
    res.json({ scripts: rows });
  } catch (err) {
    console.error('admin.listScriptMaster', err);
    res.status(500).json({ error: 'Failed to load scripts' });
  }
};

exports.updateScriptActive = async (req, res) => {
  const { id, is_active } = req.body;
  
  if (!id || typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'id and is_active are required' });
  }
  
  try {
    const { rows } = await db.query(`
      UPDATE scripts
      SET is_active = $1
      WHERE id = $2
      RETURNING id, name, exchange, is_active, is_banned, current_price, lot_size
    `, [is_active, id]);
    
    if (!rows.length) return res.status(404).json({ error: 'Script not found' });
    res.json({ script: rows[0] });
  } catch (err) {
    console.error('admin.updateScriptActive', err);
    res.status(500).json({ error: 'Failed to update script' });
  }
};

exports.createScript = async (req, res) => {
  const { name, exchange, expiry, lot_size, max_lots, margin_per_lot, current_price } = req.body || {};

  if (!name || !exchange) {
    return res.status(400).json({ error: 'name and exchange are required' });
  }
  const cleanName = String(name).toUpperCase().trim();
  const cleanExchange = String(exchange).toUpperCase().trim();

  if (!/^[A-Z0-9_&.-]{1,50}$/.test(cleanName)) {
    return res.status(400).json({ error: 'Script name must be letters/digits only (max 50 chars)' });
  }

  try {
    const { rows } = await db.query(`
      INSERT INTO scripts 
        (name, exchange, expiry, lot_size, max_lots, margin_per_lot, current_price, prev_close, is_active, is_banned)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $7, true, false)
      RETURNING id, name, exchange, expiry, lot_size, max_lots, margin_per_lot, current_price, is_active, is_banned, created_at
    `, [
      cleanName,
      cleanExchange,
      expiry || null,
      Number(lot_size) > 0 ? Number(lot_size) : 1,
      Number(max_lots) > 0 ? Number(max_lots) : 100,
      Number(margin_per_lot) > 0 ? Number(margin_per_lot) : null,
      Number(current_price) > 0 ? Number(current_price) : 0,
    ]);
    res.json({ script: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `Script "${cleanName}" already exists in ${cleanExchange}` });
    }
    console.error('admin.createScript', err);
    res.status(500).json({ error: 'Failed to create script' });
  }
};

exports.deleteScript = async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await db.query(`DELETE FROM scripts WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Script not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Cannot delete — this script has existing trades or positions' });
    }
    console.error('admin.deleteScript', err);
    res.status(500).json({ error: 'Failed to delete script' });
  }
};

const forensicService = require('../services/forensicService');

exports.getUserForensics = async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  try {
    // 1. Detect Impossible Performance
    const performanceReport = await forensicService.detectImpossiblePerformance(userId);

    // 2. Replay User Transactions
    const replayReport = await forensicService.replayUserTransactions(userId);

    res.json({
      user_id: userId,
      behavior_analysis: performanceReport,
      portfolio_integrity: replayReport
    });
  } catch (err) {
    console.error('admin.getUserForensics', err);
    res.status(500).json({ error: 'Failed to run forensic analysis' });
  }
};

exports.getWeeklyReport = async (req, res) => {
  try {
    const { user_id, week_start } = req.query;

    // Determine week range (Mon–Sun)
    let weekStart;
    if (week_start) {
      weekStart = new Date(week_start);
    } else {
      weekStart = new Date();
      const day = weekStart.getDay(); // 0=Sun
      const diff = day === 0 ? -6 : 1 - day;
      weekStart.setDate(weekStart.getDate() + diff);
    }
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const params = [weekStart.toISOString(), weekEnd.toISOString()];
    let userFilter = '';
    if (user_id) {
      params.push(Number(user_id));
      userFilter = `AND t.user_id = $${params.length}`;
    }

    const { rows } = await db.query(`
      SELECT
        u.id AS user_id,
        u.username,
        u.full_name,
        t.created_at::date AS trade_date,
        COUNT(*) FILTER (WHERE t.status='EXECUTED')::int AS total_trades,
        COUNT(*) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY')::int AS buy_trades,
        COUNT(*) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL')::int AS sell_trades,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'), 0)::numeric AS total_buy_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric AS total_sell_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric
          - COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'), 0)::numeric AS net_pnl
      FROM trades t
      JOIN users u ON u.id = t.user_id
      WHERE t.created_at >= $1 AND t.created_at < $2
        ${userFilter}
      GROUP BY u.id, u.username, u.full_name, t.created_at::date
      ORDER BY u.username, t.created_at::date
    `, params);

    // Summarize per-user totals
    const userMap = {};
    for (const row of rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = {
          user_id: row.user_id,
          username: row.username,
          full_name: row.full_name,
          total_trades: 0,
          buy_trades: 0,
          sell_trades: 0,
          total_buy_value: 0,
          total_sell_value: 0,
          net_pnl: 0,
          daily: []
        };
      }
      const u = userMap[row.user_id];
      u.total_trades += row.total_trades;
      u.buy_trades += row.buy_trades;
      u.sell_trades += row.sell_trades;
      u.total_buy_value += Number(row.total_buy_value);
      u.total_sell_value += Number(row.total_sell_value);
      u.net_pnl += Number(row.net_pnl);
      u.daily.push({
        date: row.trade_date,
        total_trades: row.total_trades,
        buy_trades: row.buy_trades,
        sell_trades: row.sell_trades,
        total_buy_value: Number(row.total_buy_value),
        total_sell_value: Number(row.total_sell_value),
        net_pnl: Number(row.net_pnl)
      });
    }

    res.json({
      week_start: weekStart.toISOString().split('T')[0],
      week_end: weekEnd.toISOString().split('T')[0],
      users: Object.values(userMap)
    });
  } catch (err) {
    console.error('admin.getWeeklyReport', err);
    res.status(500).json({ error: 'Failed to generate weekly report' });
  }
};

/* ─── Close All Positions (Admin) ───────────────────────────────────────────── */
exports.closeAllPositions = async (req, res) => {
  try {
    // Get all open positions
    const { rows: positions } = await db.query(`
      SELECT p.id, p.user_id, p.script_id, p.buy_qty, p.sell_qty, p.avg_buy_price, p.avg_sell_price,
             s.name AS script, s.current_price
      FROM positions p
      JOIN scripts s ON s.id = p.script_id
      WHERE p.buy_qty > 0 OR p.sell_qty > 0
    `);

    let closed = 0;
    for (const p of positions) {
      const netQty = p.buy_qty - p.sell_qty;
      if (netQty === 0) continue;
      const ltp = Number(p.current_price || 0);
      const isLong = netQty > 0;
      const avgPrice = isLong ? Number(p.avg_buy_price) : Number(p.avg_sell_price);
      const m2m = isLong
        ? (ltp - avgPrice) * netQty
        : (avgPrice - ltp) * Math.abs(netQty);

      // Reset position
      await db.query(`UPDATE positions SET buy_qty=0, sell_qty=0 WHERE id=$1`, [p.id]);

      // Record ledger entry
      const curBalance = await db.query(`SELECT balance FROM users WHERE id=$1`, [p.user_id]);
      const bal = Number(curBalance.rows[0]?.balance || 0);
      const newBal = bal + m2m;
      if (m2m !== 0) {
        await db.query(`UPDATE users SET balance=$1 WHERE id=$2`, [newBal, p.user_id]);
        await db.query(`
          INSERT INTO ledger (user_id, description, debit, credit, balance)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          p.user_id,
          `Admin Close — ${p.script} @ ${ltp}`,
          m2m < 0 ? Math.abs(m2m) : 0,
          m2m > 0 ? m2m : 0,
          newBal,
        ]);
      }
      closed++;
    }
    res.json({ ok: true, closed });
  } catch (err) {
    console.error('admin.closeAllPositions', err);
    res.status(500).json({ error: 'Failed to close positions' });
  }
};

exports.closeUserPositions = async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const { rows: positions } = await db.query(`
      SELECT p.id, p.user_id, p.script_id, p.buy_qty, p.sell_qty, p.avg_buy_price, p.avg_sell_price,
             s.name AS script, s.current_price
      FROM positions p JOIN scripts s ON s.id = p.script_id
      WHERE p.user_id = $1 AND (p.buy_qty > 0 OR p.sell_qty > 0)
    `, [userId]);

    let closed = 0;
    for (const p of positions) {
      const netQty = p.buy_qty - p.sell_qty;
      if (netQty === 0) continue;
      const ltp = Number(p.current_price || 0);
      const isLong = netQty > 0;
      const avgPrice = isLong ? Number(p.avg_buy_price) : Number(p.avg_sell_price);
      const m2m = isLong ? (ltp - avgPrice) * netQty : (avgPrice - ltp) * Math.abs(netQty);
      await db.query(`UPDATE positions SET buy_qty=0, sell_qty=0 WHERE id=$1`, [p.id]);
      const curBal = await db.query(`SELECT balance FROM users WHERE id=$1`, [userId]);
      const newBal = Number(curBal.rows[0]?.balance || 0) + m2m;
      if (m2m !== 0) {
        await db.query(`UPDATE users SET balance=$1 WHERE id=$2`, [newBal, userId]);
        await db.query(`INSERT INTO ledger (user_id, description, debit, credit, balance) VALUES ($1,$2,$3,$4,$5)`,
          [userId, `Admin Close — ${p.script} @ ${ltp}`, m2m < 0 ? Math.abs(m2m) : 0, m2m > 0 ? m2m : 0, newBal]);
      }
      closed++;
    }
    res.json({ ok: true, closed });
  } catch (err) {
    console.error('admin.closeUserPositions', err);
    res.status(500).json({ error: 'Failed to close user positions' });
  }
};

/* ─── Summary Report (date-range, multi-filter) ─────────────────────────────── */
exports.getSummaryReport = async (req, res) => {
  try {
    const { start_date, end_date, user_id, script, exchange } = req.query;

    const start = start_date ? new Date(start_date) : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
    const end   = end_date   ? new Date(end_date)   : new Date();
    end.setHours(23, 59, 59, 999);

    const params = [start.toISOString(), end.toISOString()];
    let filters = '';
    if (user_id)  { params.push(Number(user_id));  filters += ` AND t.user_id = $${params.length}`; }
    if (script)   { params.push(script);            filters += ` AND s.name = $${params.length}`; }
    if (exchange) { params.push(exchange);          filters += ` AND s.exchange = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        u.id AS user_id, u.username, u.full_name,
        COUNT(*) FILTER (WHERE t.status='EXECUTED')::int AS total_trades,
        COUNT(*) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY')::int AS buy_trades,
        COUNT(*) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL')::int AS sell_trades,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'), 0)::numeric AS buy_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric AS sell_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric
          - COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'), 0)::numeric AS net_pnl,
        (SELECT balance FROM users WHERE id = u.id) AS ledger_balance
      FROM trades t
      JOIN users u ON u.id = t.user_id
      JOIN scripts s ON s.id = t.script_id
      WHERE t.created_at >= $1 AND t.created_at <= $2 ${filters}
      GROUP BY u.id, u.username, u.full_name
      ORDER BY u.username
    `, params);

    res.json({
      start_date: start.toISOString().split('T')[0],
      end_date: end.toISOString().split('T')[0],
      users: rows.map(r => ({
        ...r,
        buy_value: Number(r.buy_value),
        sell_value: Number(r.sell_value),
        net_pnl: Number(r.net_pnl),
        ledger_balance: Number(r.ledger_balance || 0),
        total_turnover: Number(r.buy_value) + Number(r.sell_value),
      })),
    });
  } catch (err) {
    console.error('admin.getSummaryReport', err);
    res.status(500).json({ error: 'Failed to generate summary report' });
  }
};

/* ─── Script Wise Summary ────────────────────────────────────────────────────── */
exports.getScriptWiseSummary = async (req, res) => {
  try {
    const { start_date, end_date, user_id, exchange } = req.query;
    const start = start_date ? new Date(start_date) : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
    const end   = end_date   ? new Date(end_date)   : new Date();
    end.setHours(23, 59, 59, 999);

    const params = [start.toISOString(), end.toISOString()];
    let filters = '';
    if (user_id)  { params.push(Number(user_id));  filters += ` AND t.user_id = $${params.length}`; }
    if (exchange) { params.push(exchange);          filters += ` AND s.exchange = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        s.id AS script_id,
        s.name AS script,
        s.exchange,
        s.expiry,
        COUNT(*) FILTER (WHERE t.status='EXECUTED')::int                                    AS total_trades,
        COUNT(*) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY')::int             AS buy_trades,
        COUNT(*) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL')::int            AS sell_trades,
        COALESCE(SUM(t.quantity) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'),  0)::numeric AS buy_qty,
        COALESCE(SUM(t.quantity) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric AS sell_qty,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'),  0)::numeric AS buy_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric AS sell_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='SELL'), 0)::numeric
          - COALESCE(SUM(t.total_value) FILTER (WHERE t.status='EXECUTED' AND t.trade_type='BUY'), 0)::numeric AS net_pnl,
        COUNT(DISTINCT t.user_id)::int AS unique_clients,
        s.current_price AS ltp
      FROM trades t
      JOIN scripts s ON s.id = t.script_id
      WHERE t.created_at >= $1 AND t.created_at <= $2 ${filters}
      GROUP BY s.id, s.name, s.exchange, s.expiry, s.current_price
      ORDER BY total_trades DESC
    `, params);

    res.json({
      start_date: start.toISOString().split('T')[0],
      end_date: end.toISOString().split('T')[0],
      scripts: rows.map(r => ({
        ...r,
        buy_qty:   Number(r.buy_qty),
        sell_qty:  Number(r.sell_qty),
        buy_value:  Number(r.buy_value),
        sell_value: Number(r.sell_value),
        net_pnl:    Number(r.net_pnl),
        total_turnover: Number(r.buy_value) + Number(r.sell_value),
      })),
    });
  } catch (err) {
    console.error('admin.getScriptWiseSummary', err);
    res.status(500).json({ error: 'Failed to generate script-wise summary' });
  }
};

/* ─── Margin Per-Market Breakdown ───────────────────────────────────────────── */
exports.getMarginBreakdown = async (req, res) => {
  try {
    const { user_id } = req.query;
    let userFilter = '';
    const params = [];
    if (user_id) { params.push(Number(user_id)); userFilter = `AND u.id = $${params.length}`; }

    // Get per-user, per-exchange exposure from positions (qty * margin_per_lot)
    const { rows } = await db.query(`
      SELECT
        u.id, u.username, u.full_name, u.balance, u.exposure,
        u.brokerage_type, u.brokerage_value,
        COALESCE(SUM(CASE WHEN s.exchange IN ('NSEFUT','NSE-FUT') THEN (p.buy_qty + p.sell_qty) * COALESCE(s.margin_per_lot, s.lot_size * s.current_price * 0.1, 0) ELSE 0 END), 0)::numeric AS nsefut_margin,
        COALESCE(SUM(CASE WHEN s.exchange IN ('MCXFUT','MCX-FUT','MCX') THEN (p.buy_qty + p.sell_qty) * COALESCE(s.margin_per_lot, s.lot_size * s.current_price * 0.1, 0) ELSE 0 END), 0)::numeric AS mcxfut_margin,
        COALESCE(SUM(CASE WHEN s.exchange IN ('NSEOPT','NSE-OPT') THEN (p.buy_qty + p.sell_qty) * COALESCE(s.margin_per_lot, s.lot_size * s.current_price * 0.1, 0) ELSE 0 END), 0)::numeric AS nseopt_margin,
        COALESCE(SUM(CASE WHEN s.exchange IN ('MCXOPT','MCX-OPT') THEN (p.buy_qty + p.sell_qty) * COALESCE(s.margin_per_lot, s.lot_size * s.current_price * 0.1, 0) ELSE 0 END), 0)::numeric AS mcxopt_margin,
        COALESCE(SUM(CASE WHEN s.exchange IN ('NSEEQT','NSE-EQT','NSE') THEN (p.buy_qty + p.sell_qty) * COALESCE(s.margin_per_lot, s.lot_size * s.current_price * 0.1, 0) ELSE 0 END), 0)::numeric AS nseeqt_margin,
        (SELECT COUNT(*) FROM positions p2 WHERE p2.user_id = u.id AND (p2.buy_qty > 0 OR p2.sell_qty > 0))::int AS open_positions
      FROM users u
      LEFT JOIN positions p ON p.user_id = u.id AND (p.buy_qty > 0 OR p.sell_qty > 0)
      LEFT JOIN scripts s ON s.id = p.script_id
      WHERE u.role = 'user' ${userFilter}
      GROUP BY u.id, u.username, u.full_name, u.balance, u.exposure, u.brokerage_type, u.brokerage_value
      ORDER BY u.username
    `, params);

    res.json({
      users: rows.map(r => ({
        id: r.id,
        username: r.username,
        full_name: r.full_name,
        balance: Number(r.balance || 0),
        exposure: Number(r.exposure || 0),
        open_positions: r.open_positions,
        nsefut: Number(r.nsefut_margin || 0),
        mcxfut: Number(r.mcxfut_margin || 0),
        nseopt: Number(r.nseopt_margin || 0),
        mcxopt: Number(r.mcxopt_margin || 0),
        nseeqt: Number(r.nseeqt_margin || 0),
        global: Number(r.nsefut_margin || 0) + Number(r.mcxfut_margin || 0) + Number(r.nseopt_margin || 0) + Number(r.mcxopt_margin || 0) + Number(r.nseeqt_margin || 0),
      })),
    });
  } catch (err) {
    console.error('admin.getMarginBreakdown', err);
    res.status(500).json({ error: 'Failed to generate margin breakdown' });
  }
};

/* ─── Roll Over Positions ────────────────────────────────────────────────────── */
exports.rollOverPositions = async (req, res) => {
  // Roll over all positions in a given exchange from one expiry to the next available expiry script
  const { exchange, from_expiry, to_script_id, user_id } = req.body || {};
  if (!exchange) return res.status(400).json({ error: 'exchange is required' });

  try {
    // Find all open positions in the source exchange
    let posQuery = `
      SELECT p.id, p.user_id, p.script_id, p.buy_qty, p.sell_qty, p.avg_buy_price, p.avg_sell_price,
             s.name AS script, s.exchange, s.expiry, s.lot_size, s.current_price
      FROM positions p
      JOIN scripts s ON s.id = p.script_id
      WHERE s.exchange = $1 AND (p.buy_qty > 0 OR p.sell_qty > 0)
    `;
    const posParams = [exchange];

    if (from_expiry) { posParams.push(from_expiry); posQuery += ` AND s.expiry = $${posParams.length}`; }
    if (user_id)     { posParams.push(Number(user_id)); posQuery += ` AND p.user_id = $${posParams.length}`; }

    const { rows: positions } = await db.query(posQuery, posParams);

    if (!positions.length) return res.json({ ok: true, rolled: 0, message: 'No open positions to roll over' });

    let rolled = 0;
    const errors = [];

    for (const pos of positions) {
      try {
        // Find target script: same name in the same exchange but a later expiry
        let targetScript;
        if (to_script_id) {
          const tgt = await db.query(`SELECT id, name, current_price FROM scripts WHERE id = $1`, [Number(to_script_id)]);
          if (tgt.rows.length) targetScript = tgt.rows[0];
        } else {
          // Auto-pick: same name, later expiry
          const tgt = await db.query(`
            SELECT id, name, current_price FROM scripts
            WHERE name = $1 AND exchange = $2 AND expiry > $3 AND is_active = true
            ORDER BY expiry ASC LIMIT 1
          `, [pos.script, exchange, pos.expiry || '1970-01-01']);
          if (tgt.rows.length) targetScript = tgt.rows[0];
        }

        if (!targetScript) {
          errors.push(`No next-expiry script found for ${pos.script}`);
          continue;
        }

        // Close current position (set to 0)
        await db.query(`UPDATE positions SET buy_qty=0, sell_qty=0 WHERE id=$1`, [pos.id]);

        // Open or update position in target script
        const existingPos = await db.query(`SELECT id FROM positions WHERE user_id=$1 AND script_id=$2`, [pos.user_id, targetScript.id]);
        const ltp = Number(targetScript.current_price || pos.avg_buy_price || pos.avg_sell_price);

        if (existingPos.rows.length) {
          const ep = existingPos.rows[0];
          const netBuy  = pos.buy_qty  || 0;
          const netSell = pos.sell_qty || 0;
          await db.query(`
            UPDATE positions
            SET buy_qty  = buy_qty  + $1,
                sell_qty = sell_qty + $2,
                avg_buy_price  = CASE WHEN $1 > 0 THEN $3 ELSE avg_buy_price END,
                avg_sell_price = CASE WHEN $2 > 0 THEN $3 ELSE avg_sell_price END,
                updated_at = NOW()
            WHERE id = $4
          `, [netBuy, netSell, ltp, ep.id]);
        } else {
          await db.query(`
            INSERT INTO positions (user_id, script_id, buy_qty, sell_qty, avg_buy_price, avg_sell_price)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [pos.user_id, targetScript.id, pos.buy_qty || 0, pos.sell_qty || 0, ltp, ltp]);
        }

        // Record rollover in ledger
        await db.query(`
          INSERT INTO ledger (user_id, description, debit, credit, balance)
          SELECT $1, $2, 0, 0, balance FROM users WHERE id = $1
        `, [pos.user_id, `Rollover: ${pos.script} → ${targetScript.name} @ ${ltp}`]);

        rolled++;
      } catch (innerErr) {
        errors.push(`${pos.script}: ${innerErr.message}`);
      }
    }

    res.json({ ok: true, rolled, total: positions.length, errors });
  } catch (err) {
    console.error('admin.rollOverPositions', err);
    res.status(500).json({ error: 'Roll over failed' });
  }
};

/* ═══════════════════════════════════════════════════════════════════════════════
   UTILITY LOG ENDPOINTS
   ═══════════════════════════════════════════════════════════════════════════════ */

/* Helper: parse date-range params */
function parseDateRange(query) {
  const now = new Date();
  const start = query.start_date ? new Date(query.start_date) : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
  const end   = query.end_date   ? new Date(query.end_date)   : now;
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

/* ── Trade Edit/Delete Log ───────────────────────────────────────────────────── */
exports.getTradeEditLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id, action } = req.query;
    const params = [start, end];
    let filters = '';
    if (user_id) { params.push(Number(user_id)); filters += ` AND tl.user_id = $${params.length}`; }
    if (action)  { params.push(action.toUpperCase()); filters += ` AND tl.action = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT tl.id, tl.action,
             tl.old_values::text AS old_value,
             tl.new_values::text AS new_value,
             tl.created_at AS logged_at,
             u.username AS user_name, u.full_name,
             adm.username AS admin_name,
             t.trade_type, t.quantity, t.price, t.status,
             s.name AS script
      FROM trade_logs tl
      LEFT JOIN users u    ON u.id   = tl.user_id
      LEFT JOIN users adm  ON adm.id = tl.done_by
      LEFT JOIN trades t   ON t.id   = tl.trade_id
      LEFT JOIN scripts s  ON s.id   = t.script_id
      WHERE tl.created_at >= $1 AND tl.created_at <= $2 ${filters}
      ORDER BY tl.created_at DESC
      LIMIT 500
    `, params);
    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getTradeEditLog', err);
    res.status(500).json({ error: 'Failed to load trade edit log' });
  }
};

/* ── User Edit Log ───────────────────────────────────────────────────────────── */
exports.getUserEditLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id } = req.query;
    const params = [start, end];
    let filters = '';
    if (user_id) { params.push(Number(user_id)); filters += ` AND tl.user_id = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        tl.id, tl.action,
        tl.old_values::text AS old_value,
        tl.new_values::text AS new_value,
        tl.created_at AS logged_at,
        u.username AS target_user, u.full_name,
        adm.username AS admin_name
      FROM trade_logs tl
      LEFT JOIN users u    ON u.id   = tl.user_id
      LEFT JOIN users adm  ON adm.id = tl.done_by
      WHERE tl.created_at >= $1 AND tl.created_at <= $2
        AND tl.action LIKE '%USER%' ${filters}
      ORDER BY tl.created_at DESC
      LIMIT 500
    `, params);
    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getUserEditLog', err);
    res.status(500).json({ error: 'Failed to load user edit log' });
  }
};

/* ── IP Address Log ──────────────────────────────────────────────────────────── */
// trade_logs has no ip_address — use login_logs table if it exists, else derive from trade_logs + users
exports.getIpLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id, ip } = req.query;

    // Check if login_logs table exists
    const tableCheck = await db.query(`SELECT to_regclass('public.login_logs') AS tbl`);
    const hasLoginLogs = tableCheck.rows[0]?.tbl !== null;

    let rows;
    if (hasLoginLogs) {
      const params = [start, end];
      let filters = '';
      if (user_id) { params.push(Number(user_id)); filters += ` AND ll.user_id = $${params.length}`; }
      if (ip)      { params.push(`%${ip}%`);        filters += ` AND ll.ip_address ILIKE $${params.length}`; }
      const r = await db.query(`
        SELECT ll.id, ll.action, ll.ip_address, ll.created_at AS logged_at,
               u.username, u.full_name,
               COUNT(*) OVER (PARTITION BY ll.user_id, ll.ip_address)::int AS login_count
        FROM login_logs ll
        LEFT JOIN users u ON u.id = ll.user_id
        WHERE ll.created_at >= $1 AND ll.created_at <= $2 ${filters}
        ORDER BY ll.created_at DESC LIMIT 500
      `, params);
      rows = r.rows;
    } else {
      // Fallback: show trade_logs grouped by user with done_by info
      const params = [start, end];
      let filters = '';
      if (user_id) { params.push(Number(user_id)); filters += ` AND tl.user_id = $${params.length}`; }
      const r = await db.query(`
        SELECT tl.id, tl.action, tl.created_at AS logged_at,
               u.username, u.full_name,
               'N/A' AS ip_address,
               COUNT(*) OVER (PARTITION BY tl.user_id)::int AS login_count
        FROM trade_logs tl
        LEFT JOIN users u ON u.id = tl.user_id
        WHERE tl.created_at >= $1 AND tl.created_at <= $2 ${filters}
        ORDER BY tl.created_at DESC LIMIT 500
      `, params);
      rows = r.rows;
    }
    res.json({ logs: rows, has_login_logs: hasLoginLogs });
  } catch (err) {
    console.error('admin.getIpLog', err);
    res.status(500).json({ error: 'Failed to load IP log' });
  }
};

/* ── Cash Edit/Delete Log ────────────────────────────────────────────────────── */
exports.getCashEditLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id } = req.query;
    const params = [start, end];
    let uFilter = '';
    if (user_id) { params.push(Number(user_id)); uFilter = `AND l.user_id = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        l.id, l.description, l.debit, l.credit, l.balance,
        l.created_at AS logged_at,
        u.username, u.full_name,
        CASE WHEN l.debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END AS type
      FROM ledger l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.created_at >= $1 AND l.created_at <= $2
        AND (l.description LIKE '%Admin%' OR l.description LIKE '%admin%'
             OR l.description LIKE '%Credit%' OR l.description LIKE '%Debit%'
             OR l.description LIKE '%Close%' OR l.description LIKE '%Rollover%') ${uFilter}
      ORDER BY l.created_at DESC
      LIMIT 500
    `, params);
    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getCashEditLog', err);
    res.status(500).json({ error: 'Failed to load cash log' });
  }
};

/* ── Auto SquareUp Log ───────────────────────────────────────────────────────── */
exports.getAutoSquareUpLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id } = req.query;
    const params = [start, end];
    let uFilter = '';
    if (user_id) { params.push(Number(user_id)); uFilter = `AND t.user_id = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        t.id AS trade_id, t.trade_type, t.quantity, t.price, t.total_value,
        t.status, t.created_at AS logged_at,
        t.rejection_reason AS reason,
        u.username, u.full_name, u.auto_cut, u.auto_cut_limit,
        s.name AS script, s.exchange
      FROM trades t
      LEFT JOIN users u  ON u.id  = t.user_id
      LEFT JOIN scripts s ON s.id = t.script_id
      WHERE t.created_at >= $1 AND t.created_at <= $2
        AND (t.rejection_reason LIKE '%auto%' OR t.rejection_reason LIKE '%Auto%'
             OR t.rejection_reason LIKE '%square%' OR t.rejection_reason LIKE '%cut%'
             OR t.status = 'AUTO_CLOSED') ${uFilter}
      ORDER BY t.created_at DESC
      LIMIT 500
    `, params);
    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getAutoSquareUpLog', err);
    res.status(500).json({ error: 'Failed to load auto square-up log' });
  }
};

/* ── Cross Trade Log ─────────────────────────────────────────────────────────── */
exports.getCrossTradeLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id, script } = req.query;
    const params = [start, end];
    let filters = '';
    if (user_id) { params.push(Number(user_id)); filters += ` AND t.user_id = $${params.length}`; }
    if (script)  { params.push(script);           filters += ` AND s.name = $${params.length}`; }

    // Cross trades: BUY and SELL of same script at same time by different users
    const { rows } = await db.query(`
      WITH trade_pairs AS (
        SELECT
          t1.id AS buy_id,  t2.id AS sell_id,
          t1.user_id AS buyer_id, t2.user_id AS seller_id,
          t1.price, t1.quantity, t1.total_value,
          t1.created_at, s.name AS script, s.exchange
        FROM trades t1
        JOIN trades t2 ON t2.script_id = t1.script_id
                      AND t2.trade_type = 'SELL'
                      AND t1.trade_type = 'BUY'
                      AND t2.user_id != t1.user_id
                      AND ABS(EXTRACT(EPOCH FROM (t2.created_at - t1.created_at))) < 5
                      AND t2.price = t1.price
                      AND t2.status = 'EXECUTED'
                      AND t1.status = 'EXECUTED'
        JOIN scripts s ON s.id = t1.script_id
        WHERE t1.created_at >= $1 AND t1.created_at <= $2 ${filters}
      )
      SELECT tp.*,
             ub.username AS buyer_name,  ub.full_name AS buyer_full,
             us.username AS seller_name, us.full_name AS seller_full
      FROM trade_pairs tp
      LEFT JOIN users ub ON ub.id = tp.buyer_id
      LEFT JOIN users us ON us.id = tp.seller_id
      ORDER BY tp.created_at DESC
      LIMIT 200
    `, params);
    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getCrossTradeLog', err);
    res.status(500).json({ error: 'Failed to load cross trade log' });
  }
};

/* ── Rejection Log ───────────────────────────────────────────────────────────── */
exports.getRejectionLog = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id, exchange, reason } = req.query;
    const params = [start, end];
    let filters = '';
    if (user_id)  { params.push(Number(user_id)); filters += ` AND t.user_id = $${params.length}`; }
    if (exchange) { params.push(exchange);         filters += ` AND s.exchange = $${params.length}`; }
    if (reason)   { params.push(`%${reason}%`);   filters += ` AND t.rejection_reason ILIKE $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        t.id, t.trade_type, t.quantity, t.price, t.total_value,
        t.rejection_reason, t.status, t.created_at,
        u.username, u.full_name,
        s.name AS script, s.exchange
      FROM trades t
      LEFT JOIN users u   ON u.id  = t.user_id
      LEFT JOIN scripts s ON s.id  = t.script_id
      WHERE t.created_at >= $1 AND t.created_at <= $2
        AND t.status = 'REJECTED' ${filters}
      ORDER BY t.created_at DESC
      LIMIT 500
    `, params);
    res.json({ logs: rows, total: rows.length });
  } catch (err) {
    console.error('admin.getRejectionLog', err);
    res.status(500).json({ error: 'Failed to load rejection log' });
  }
};

/* ── Bulk Trading ────────────────────────────────────────────────────────────── */
exports.executeBulkTrade = async (req, res) => {
  const { script_id, trade_type, quantity, price, user_ids, notes } = req.body || {};
  if (!script_id || !trade_type || !quantity || !user_ids?.length) {
    return res.status(400).json({ error: 'script_id, trade_type, quantity, user_ids[] are required' });
  }
  try {
    const script = await db.query(`SELECT * FROM scripts WHERE id = $1 AND is_active = true`, [Number(script_id)]);
    if (!script.rows.length) return res.status(404).json({ error: 'Script not found or inactive' });
    const scr = script.rows[0];
    const tradePrice = Number(price) > 0 ? Number(price) : Number(scr.current_price);
    const tradeQty   = Number(quantity);
    const totalValue = tradePrice * tradeQty;

    const results = [];
    for (const uid of user_ids) {
      try {
        const user = await db.query(`SELECT id, username, balance FROM users WHERE id = $1 AND is_active = true`, [Number(uid)]);
        if (!user.rows.length) { results.push({ user_id: uid, status: 'SKIP', reason: 'User not found/inactive' }); continue; }
        const u = user.rows[0];
        if (trade_type === 'BUY' && Number(u.balance) < totalValue) {
          results.push({ user_id: uid, username: u.username, status: 'REJECTED', reason: 'Insufficient balance' }); continue;
        }
        const { rows: tradeRows } = await db.query(`
          INSERT INTO trades (user_id, script_id, trade_type, quantity, price, total_value, status, notes)
          VALUES ($1, $2, $3, $4, $5, $6, 'EXECUTED', $7)
          RETURNING id
        `, [uid, script_id, trade_type.toUpperCase(), tradeQty, tradePrice, totalValue, notes || 'Admin bulk trade']);

        // Update balance
        const balChange = trade_type === 'BUY' ? -totalValue : totalValue;
        const newBal = Number(u.balance) + balChange;
        await db.query(`UPDATE users SET balance = $1 WHERE id = $2`, [newBal, uid]);
        await db.query(`INSERT INTO ledger (user_id, description, debit, credit, balance) VALUES ($1,$2,$3,$4,$5)`,
          [uid, `Bulk ${trade_type}: ${scr.name} x${tradeQty} @ ${tradePrice}`,
           balChange < 0 ? Math.abs(balChange) : 0, balChange > 0 ? balChange : 0, newBal]);

        results.push({ user_id: uid, username: u.username, trade_id: tradeRows[0].id, status: 'EXECUTED', price: tradePrice, qty: tradeQty });
      } catch (innerErr) {
        results.push({ user_id: uid, status: 'ERROR', reason: innerErr.message });
      }
    }
    res.json({ ok: true, executed: results.filter(r => r.status === 'EXECUTED').length, total: user_ids.length, results });
  } catch (err) {
    console.error('admin.executeBulkTrade', err);
    res.status(500).json({ error: 'Bulk trade failed' });
  }
};

/* ── Bill Filter (Trade Summary per user/date with bill format) ──────────────── */
exports.getBillFilter = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const { user_id, exchange, script } = req.query;
    const params = [start, end];
    let filters = '';
    if (user_id)  { params.push(Number(user_id)); filters += ` AND t.user_id = $${params.length}`; }
    if (exchange) { params.push(exchange);         filters += ` AND s.exchange = $${params.length}`; }
    if (script)   { params.push(script);           filters += ` AND s.name = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT
        u.id AS user_id, u.username, u.full_name,
        s.name AS script, s.exchange, s.expiry,
        t.trade_type,
        COUNT(*)::int                                AS trade_count,
        SUM(t.quantity)::numeric                     AS total_qty,
        AVG(t.price)::numeric                        AS avg_price,
        SUM(t.total_value)::numeric                  AS total_value,
        COALESCE(u.brokerage_value, 0)::numeric      AS brokerage_rate,
        u.brokerage_type,
        CASE WHEN u.brokerage_type = 'per_lot' THEN SUM(t.quantity) * COALESCE(u.brokerage_value,0)
             ELSE SUM(t.total_value) / 10000000 * COALESCE(u.brokerage_value,0) END::numeric AS brokerage_amount,
        MIN(t.created_at)::date AS trade_date
      FROM trades t
      JOIN users u   ON u.id  = t.user_id
      JOIN scripts s ON s.id  = t.script_id
      WHERE t.created_at >= $1 AND t.created_at <= $2
        AND t.status = 'EXECUTED' ${filters}
      GROUP BY u.id, u.username, u.full_name, s.name, s.exchange, s.expiry,
               t.trade_type, u.brokerage_value, u.brokerage_type
      ORDER BY u.username, s.name, t.trade_type
    `, params);

    // Group into bill format per user
    const userMap = {};
    for (const r of rows) {
      if (!userMap[r.user_id]) {
        userMap[r.user_id] = { user_id: r.user_id, username: r.username, full_name: r.full_name, trades: [], total_brokerage: 0, net_pnl: 0 };
      }
      userMap[r.user_id].trades.push({
        script: r.script, exchange: r.exchange, expiry: r.expiry,
        trade_type: r.trade_type, trade_count: r.trade_count,
        total_qty: Number(r.total_qty), avg_price: Number(r.avg_price),
        total_value: Number(r.total_value), brokerage_amount: Number(r.brokerage_amount),
        trade_date: r.trade_date,
      });
      userMap[r.user_id].total_brokerage += Number(r.brokerage_amount);
      userMap[r.user_id].net_pnl += r.trade_type === 'SELL' ? Number(r.total_value) : -Number(r.total_value);
    }
    res.json({
      start_date: new Date(start).toISOString().split('T')[0],
      end_date: new Date(end).toISOString().split('T')[0],
      bills: Object.values(userMap),
    });
  } catch (err) {
    console.error('admin.getBillFilter', err);
    res.status(500).json({ error: 'Failed to generate bill filter' });
  }
};

/* ═══════════════════════════════════════════════════════════════════════════════
   ACCOUNTS SECTION
   ═══════════════════════════════════════════════════════════════════════════════ */

/* ── Ledger (all users, filterable) ─────────────────────────────────────────── */
exports.getLedger = async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.query;
    const params = [];
    let filters = '';
    if (user_id) {
      params.push(Number(user_id));
      filters += ` AND l.user_id = $${params.length}`;
    }
    if (start_date) {
      params.push(new Date(start_date).toISOString());
      filters += ` AND l.created_at >= $${params.length}`;
    }
    if (end_date) {
      const e = new Date(end_date); e.setHours(23, 59, 59, 999);
      params.push(e.toISOString());
      filters += ` AND l.created_at <= $${params.length}`;
    }

    const { rows } = await db.query(`
      SELECT
        l.id, l.user_id, l.description, l.debit, l.credit, l.balance,
        l.trade_id, l.created_at,
        u.username, u.full_name,
        t.trade_type, t.quantity, t.price,
        s.name AS script, s.exchange
      FROM ledger l
      LEFT JOIN users u   ON u.id  = l.user_id
      LEFT JOIN trades t  ON t.id  = l.trade_id
      LEFT JOIN scripts s ON s.id  = t.script_id
      WHERE 1=1 ${filters}
      ORDER BY l.created_at DESC
      LIMIT 1000
    `, params);

    // Totals
    const totals = rows.reduce((a, r) => ({
      debit:  a.debit  + Number(r.debit  || 0),
      credit: a.credit + Number(r.credit || 0),
    }), { debit: 0, credit: 0 });

    res.json({ entries: rows, totals });
  } catch (err) {
    console.error('admin.getLedger', err);
    res.status(500).json({ error: 'Failed to load ledger' });
  }
};

/* ── Cash Ledger (single-user account statement) ────────────────────────────── */
exports.getCashLedger = async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const params = [Number(user_id)];
    let filters = '';
    if (start_date) {
      params.push(new Date(start_date).toISOString());
      filters += ` AND l.created_at >= $${params.length}`;
    }
    if (end_date) {
      const e = new Date(end_date); e.setHours(23, 59, 59, 999);
      params.push(e.toISOString());
      filters += ` AND l.created_at <= $${params.length}`;
    }

    const userInfo = await db.query(`SELECT id, username, full_name, balance FROM users WHERE id = $1`, [Number(user_id)]);
    if (!userInfo.rows.length) return res.status(404).json({ error: 'User not found' });

    const { rows } = await db.query(`
      SELECT
        l.id, l.description, l.debit, l.credit, l.balance, l.trade_id, l.created_at,
        t.trade_type, t.quantity, t.price,
        s.name AS script, s.exchange
      FROM ledger l
      LEFT JOIN trades t  ON t.id  = l.trade_id
      LEFT JOIN scripts s ON s.id  = t.script_id
      WHERE l.user_id = $1 ${filters}
      ORDER BY l.created_at ASC
    `, params);

    // Running balance verification
    let running = 0;
    const entries = rows.map(r => {
      running += Number(r.credit || 0) - Number(r.debit || 0);
      return { ...r, running_balance: running };
    });

    const totals = rows.reduce((a, r) => ({
      debit:  a.debit  + Number(r.debit  || 0),
      credit: a.credit + Number(r.credit || 0),
    }), { debit: 0, credit: 0 });

    res.json({ user: userInfo.rows[0], entries, totals });
  } catch (err) {
    console.error('admin.getCashLedger', err);
    res.status(500).json({ error: 'Failed to load cash ledger' });
  }
};

/* ── Cash Entry — Create (credit/debit user balance) ────────────────────────── */
exports.createCashEntry = async (req, res) => {
  const { user_id, type, amount, description, reference_no } = req.body || {};
  if (!user_id || !type || !amount) return res.status(400).json({ error: 'user_id, type, amount are required' });
  if (!['CREDIT', 'DEBIT'].includes(type.toUpperCase())) return res.status(400).json({ error: 'type must be CREDIT or DEBIT' });
  if (Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

  try {
    const user = await db.query(`SELECT id, username, balance FROM users WHERE id = $1`, [Number(user_id)]);
    if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = user.rows[0];

    const amt = Number(amount);
    const isCredit = type.toUpperCase() === 'CREDIT';
    const newBalance = isCredit ? Number(u.balance) + amt : Number(u.balance) - amt;

    if (!isCredit && newBalance < 0) return res.status(400).json({ error: `Insufficient balance. Current: ₹${Number(u.balance).toLocaleString('en-IN')}` });

    // Update user balance
    await db.query(`UPDATE users SET balance = $1 WHERE id = $2`, [newBalance, u.id]);

    // Insert ledger entry
    await db.query(`
      INSERT INTO ledger (user_id, description, debit, credit, balance)
      VALUES ($1, $2, $3, $4, $5)
    `, [u.id, description || `Admin ${type} entry${reference_no ? ` — Ref: ${reference_no}` : ''}`,
        isCredit ? 0 : amt, isCredit ? amt : 0, newBalance]);

    // Insert into cash_entries audit
    await db.query(`
      INSERT INTO cash_entries (user_id, type, amount, description, reference_no, done_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [u.id, type.toUpperCase(), amt, description || null, reference_no || null, req.user?.id || null]);

    res.json({
      ok: true,
      user: { id: u.id, username: u.username },
      type: type.toUpperCase(),
      amount: amt,
      old_balance: Number(u.balance),
      new_balance: newBalance,
    });
  } catch (err) {
    console.error('admin.createCashEntry', err);
    res.status(500).json({ error: 'Failed to create cash entry' });
  }
};

/* ── Cash Entries — List ────────────────────────────────────────────────────── */
exports.listCashEntries = async (req, res) => {
  try {
    const { user_id, type, start_date, end_date } = req.query;
    const params = [];
    let filters = '';
    if (user_id) { params.push(Number(user_id)); filters += ` AND ce.user_id = $${params.length}`; }
    if (type)    { params.push(type.toUpperCase()); filters += ` AND ce.type = $${params.length}`; }
    if (start_date) { params.push(new Date(start_date).toISOString()); filters += ` AND ce.created_at >= $${params.length}`; }
    if (end_date)   { const e = new Date(end_date); e.setHours(23,59,59,999); params.push(e.toISOString()); filters += ` AND ce.created_at <= $${params.length}`; }

    const { rows } = await db.query(`
      SELECT ce.id, ce.type, ce.amount, ce.description, ce.reference_no, ce.created_at,
             u.username, u.full_name,
             adm.username AS done_by_name
      FROM cash_entries ce
      LEFT JOIN users u   ON u.id   = ce.user_id
      LEFT JOIN users adm ON adm.id = ce.done_by
      WHERE 1=1 ${filters}
      ORDER BY ce.created_at DESC
      LIMIT 500
    `, params);

    const totals = rows.reduce((a, r) => ({
      credit: a.credit + (r.type === 'CREDIT' ? Number(r.amount) : 0),
      debit:  a.debit  + (r.type === 'DEBIT'  ? Number(r.amount) : 0),
    }), { credit: 0, debit: 0 });

    res.json({ entries: rows, totals });
  } catch (err) {
    console.error('admin.listCashEntries', err);
    res.status(500).json({ error: 'Failed to load cash entries' });
  }
};

/* ── JV — Create Journal Voucher ─────────────────────────────────────────────── */
exports.createJV = async (req, res) => {
  const { narration, entry_date, lines } = req.body || {};
  if (!lines?.length || lines.length < 2) return res.status(400).json({ error: 'At least 2 JV lines required' });

  const totalDebit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return res.status(400).json({ error: `JV not balanced — Debit: ${totalDebit.toFixed(2)}, Credit: ${totalCredit.toFixed(2)}` });
  }

  try {
    const seqRow = await db.query(`SELECT nextval('jv_seq') AS seq`);
    const jvNumber = `JV-${String(seqRow.rows[0].seq).padStart(6, '0')}`;

    const jv = await db.query(`
      INSERT INTO jv_entries (jv_number, narration, entry_date, done_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id, jv_number
    `, [jvNumber, narration || null, entry_date || new Date().toISOString().split('T')[0], req.user?.id || null]);

    const jvId = jv.rows[0].id;

    for (const line of lines) {
      await db.query(`
        INSERT INTO jv_lines (jv_id, user_id, account, debit, credit, remarks)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [jvId, line.user_id ? Number(line.user_id) : null, line.account || 'General', Number(line.debit || 0), Number(line.credit || 0), line.remarks || null]);

      // If user_id provided, reflect in user ledger
      if (line.user_id) {
        const uBal = await db.query(`SELECT balance FROM users WHERE id = $1`, [Number(line.user_id)]);
        if (uBal.rows.length) {
          const newBal = Number(uBal.rows[0].balance) + Number(line.credit || 0) - Number(line.debit || 0);
          await db.query(`UPDATE users SET balance = $1 WHERE id = $2`, [newBal, Number(line.user_id)]);
          await db.query(`INSERT INTO ledger (user_id, description, debit, credit, balance) VALUES ($1,$2,$3,$4,$5)`,
            [Number(line.user_id), `JV ${jvNumber}: ${narration || line.account}`,
             Number(line.debit || 0), Number(line.credit || 0), newBal]);
        }
      }
    }

    res.json({ ok: true, jv_number: jvNumber, jv_id: jvId, total_debit: totalDebit, total_credit: totalCredit });
  } catch (err) {
    console.error('admin.createJV', err);
    res.status(500).json({ error: 'Failed to create JV' });
  }
};

/* ── JV — List ──────────────────────────────────────────────────────────────── */
exports.listJV = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const params = [];
    let filters = '';
    if (start_date) { params.push(start_date); filters += ` AND jv.entry_date >= $${params.length}`; }
    if (end_date)   { params.push(end_date);   filters += ` AND jv.entry_date <= $${params.length}`; }

    const { rows } = await db.query(`
      SELECT jv.id, jv.jv_number, jv.narration, jv.entry_date, jv.created_at,
             adm.username AS done_by_name,
             COUNT(jl.id)::int AS line_count,
             COALESCE(SUM(jl.debit),0)::numeric AS total_debit,
             COALESCE(SUM(jl.credit),0)::numeric AS total_credit
      FROM jv_entries jv
      LEFT JOIN users adm ON adm.id = jv.done_by
      LEFT JOIN jv_lines jl ON jl.jv_id = jv.id
      WHERE 1=1 ${filters}
      GROUP BY jv.id, jv.jv_number, jv.narration, jv.entry_date, jv.created_at, adm.username
      ORDER BY jv.created_at DESC
      LIMIT 500
    `, params);

    res.json({ vouchers: rows });
  } catch (err) {
    console.error('admin.listJV', err);
    res.status(500).json({ error: 'Failed to load JV list' });
  }
};

/* ── JV — Get single ────────────────────────────────────────────────────────── */
exports.getJV = async (req, res) => {
  try {
    const { id } = req.params;
    const jv = await db.query(`SELECT jv.*, adm.username AS done_by_name FROM jv_entries jv LEFT JOIN users adm ON adm.id = jv.done_by WHERE jv.id = $1`, [Number(id)]);
    if (!jv.rows.length) return res.status(404).json({ error: 'JV not found' });

    const lines = await db.query(`
      SELECT jl.*, u.username, u.full_name FROM jv_lines jl LEFT JOIN users u ON u.id = jl.user_id WHERE jl.jv_id = $1 ORDER BY jl.id
    `, [Number(id)]);

    res.json({ jv: jv.rows[0], lines: lines.rows });
  } catch (err) {
    console.error('admin.getJV', err);
    res.status(500).json({ error: 'Failed to load JV' });
  }
};

/* ── Trial Balance ───────────────────────────────────────────────────────────── */
exports.getTrialBalance = async (req, res) => {
  try {
    const { start_date, end_date, user_id } = req.query;
    const params = [];
    let dFilter = '';
    if (start_date) { params.push(new Date(start_date).toISOString()); dFilter += ` AND l.created_at >= $${params.length}`; }
    if (end_date)   { const e = new Date(end_date); e.setHours(23,59,59,999); params.push(e.toISOString()); dFilter += ` AND l.created_at <= $${params.length}`; }
    if (user_id)    { params.push(Number(user_id)); dFilter += ` AND l.user_id = $${params.length}`; }

    // Per-user ledger summary
    const { rows: ledgerRows } = await db.query(`
      SELECT
        u.id AS user_id, u.username, u.full_name, u.balance AS current_balance,
        COALESCE(SUM(l.debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(l.credit), 0)::numeric AS total_credit,
        COUNT(l.id)::int AS entry_count
      FROM users u
      LEFT JOIN ledger l ON l.user_id = u.id ${dFilter ? 'AND 1=1' + dFilter : ''}
      WHERE u.role = 'user'
      GROUP BY u.id, u.username, u.full_name, u.balance
      ORDER BY u.username
    `, params);

    // Trading P&L summary
    const { rows: pnlRows } = await db.query(`
      SELECT
        t.user_id,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.trade_type='BUY'  AND t.status='EXECUTED'), 0)::numeric AS buy_value,
        COALESCE(SUM(t.total_value) FILTER (WHERE t.trade_type='SELL' AND t.status='EXECUTED'), 0)::numeric AS sell_value,
        COUNT(*) FILTER (WHERE t.status='EXECUTED')::int AS total_trades
      FROM trades t
      WHERE 1=1
      GROUP BY t.user_id
    `);
    const pnlMap = Object.fromEntries(pnlRows.map(r => [r.user_id, r]));

    const rows = ledgerRows.map(r => {
      const pnl = pnlMap[r.user_id] || {};
      const netPnl = Number(pnl.sell_value || 0) - Number(pnl.buy_value || 0);
      return {
        ...r,
        total_debit:  Number(r.total_debit),
        total_credit: Number(r.total_credit),
        net_ledger:   Number(r.total_credit) - Number(r.total_debit),
        buy_value:    Number(pnl.buy_value  || 0),
        sell_value:   Number(pnl.sell_value || 0),
        net_pnl:      netPnl,
        total_trades: pnl.total_trades || 0,
        current_balance: Number(r.current_balance),
      };
    });

    const grand = rows.reduce((a, r) => ({
      total_debit:  a.total_debit  + r.total_debit,
      total_credit: a.total_credit + r.total_credit,
      net_ledger:   a.net_ledger   + r.net_ledger,
      buy_value:    a.buy_value    + r.buy_value,
      sell_value:   a.sell_value   + r.sell_value,
      net_pnl:      a.net_pnl      + r.net_pnl,
    }), { total_debit: 0, total_credit: 0, net_ledger: 0, buy_value: 0, sell_value: 0, net_pnl: 0 });

    res.json({ rows, grand_total: grand });
  } catch (err) {
    console.error('admin.getTrialBalance', err);
    res.status(500).json({ error: 'Failed to generate trial balance' });
  }
};



/* ═══════════════════════════════════════════════════════════════════════════════
   SETTINGS SECTION
   ═══════════════════════════════════════════════════════════════════════════════ */

/* ── Quantity Settings — global per-exchange/per-script max qty ─────────────── */
exports.getQuantitySettings = async (req, res) => {
  try {
    // Get global qty settings from settings table
    const { rows: settRows } = await db.query(`
      SELECT key, value FROM settings
      WHERE key LIKE 'qty_%' OR key LIKE 'max_lot%' OR key LIKE 'min_lot%' OR key LIKE 'order_%'
    `);
    const qtySettings = {};
    settRows.forEach(r => { qtySettings[r.key] = r.value; });

    // Per-exchange defaults from scripts
    const { rows: exchRows } = await db.query(`
      SELECT exchange,
             AVG(max_lots)::numeric            AS avg_max_lots,
             MIN(max_lots)::int                AS min_max_lots,
             MAX(max_lots)::int                AS global_max_lots,
             COUNT(*)::int                     AS script_count
      FROM scripts
      WHERE is_active = true
      GROUP BY exchange
      ORDER BY exchange
    `);

    res.json({ qty_settings: qtySettings, exchanges: exchRows });
  } catch (err) {
    console.error('admin.getQuantitySettings', err);
    res.status(500).json({ error: 'Failed to load quantity settings' });
  }
};

exports.updateQuantitySettings = async (req, res) => {
  try {
    const settings = req.body || {};
    for (const [key, val] of Object.entries(settings)) {
      await db.query(`
        INSERT INTO settings (key, value) VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [key, JSON.stringify(val)]);
    }

    // If exchange-level max_lots provided, update scripts table
    if (settings.exchange_max_lots && typeof settings.exchange_max_lots === 'object') {
      for (const [exchange, maxLots] of Object.entries(settings.exchange_max_lots)) {
        await db.query(`UPDATE scripts SET max_lots = $1 WHERE exchange = $2 AND max_lots IS NULL`, [Number(maxLots), exchange]);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('admin.updateQuantitySettings', err);
    res.status(500).json({ error: 'Failed to update quantity settings' });
  }
};

/* ── Order Limit — per-user and global order count/value limits ─────────────── */
exports.getOrderLimits = async (req, res) => {
  try {
    // Global limits from settings
    const { rows: settRows } = await db.query(`SELECT key, value FROM settings WHERE key LIKE 'order_limit%' OR key LIKE 'daily_limit%' OR key LIKE 'max_order%'`);
    const globalLimits = {};
    settRows.forEach(r => { globalLimits[r.key] = r.value; });

    // Per-user limits (from users table — auto_cut_limit, exposure)
    const { rows: userRows } = await db.query(`
      SELECT u.id, u.username, u.full_name, u.exposure, u.auto_cut, u.auto_cut_limit,
             u.balance, u.brokerage_type, u.brokerage_value,
             (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id AND t.status = 'EXECUTED' AND t.created_at >= CURRENT_DATE)::int AS trades_today
      FROM users u
      WHERE u.role = 'user' AND u.is_active = true
      ORDER BY u.username
    `);

    res.json({ global_limits: globalLimits, users: userRows });
  } catch (err) {
    console.error('admin.getOrderLimits', err);
    res.status(500).json({ error: 'Failed to load order limits' });
  }
};

exports.updateOrderLimit = async (req, res) => {
  try {
    const { user_id, exposure, auto_cut, auto_cut_limit, global } = req.body || {};

    if (global) {
      // Update global settings
      for (const [key, val] of Object.entries(global)) {
        await db.query(`
          INSERT INTO settings (key, value) VALUES ($1, $2)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [key, JSON.stringify(val)]);
      }
    }

    if (user_id) {
      // Update user-level limits
      const updates = [];
      const params = [];
      if (exposure !== undefined)       { params.push(Number(exposure));       updates.push(`exposure = $${params.length}`); }
      if (auto_cut !== undefined)       { params.push(Boolean(auto_cut));      updates.push(`auto_cut = $${params.length}`); }
      if (auto_cut_limit !== undefined) { params.push(Number(auto_cut_limit)); updates.push(`auto_cut_limit = $${params.length}`); }

      if (updates.length) {
        params.push(Number(user_id));
        await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('admin.updateOrderLimit', err);
    res.status(500).json({ error: 'Failed to update order limit' });
  }
};

/* ── Block/Allow Scripts — ban/unban individual scripts ─────────────────────── */
exports.getBlockAllowScripts = async (req, res) => {
  try {
    const { exchange, status } = req.query;
    let filters = '';
    const params = [];
    if (exchange) { params.push(exchange); filters += ` AND s.exchange = $${params.length}`; }
    if (status === 'banned')  filters += ' AND s.is_banned = true';
    if (status === 'allowed') filters += ' AND s.is_banned = false';

    const { rows } = await db.query(`
      SELECT s.id, s.name, s.exchange, s.expiry, s.is_banned, s.ban_reason,
             s.is_active, s.max_lots, s.lot_size, s.current_price,
             (SELECT COUNT(*) FROM trades t WHERE t.script_id = s.id AND t.status = 'EXECUTED')::int AS total_trades,
             (SELECT COUNT(*) FROM trades t WHERE t.script_id = s.id AND t.status = 'EXECUTED' AND t.created_at >= CURRENT_DATE)::int AS trades_today
      FROM scripts s
      WHERE 1=1 ${filters}
      ORDER BY s.is_banned DESC, s.exchange, s.name
    `, params);

    const summary = {
      total:   rows.length,
      banned:  rows.filter(r => r.is_banned).length,
      allowed: rows.filter(r => !r.is_banned).length,
    };

    res.json({ scripts: rows, summary });
  } catch (err) {
    console.error('admin.getBlockAllowScripts', err);
    res.status(500).json({ error: 'Failed to load scripts' });
  }
};

exports.toggleScriptBlock = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_banned, ban_reason } = req.body || {};

    await db.query(`
      UPDATE scripts SET is_banned = $1, ban_reason = $2 WHERE id = $3
    `, [Boolean(is_banned), ban_reason || null, Number(id)]);

    // If banning, also reject any pending orders for this script
    if (is_banned) {
      await db.query(`UPDATE trades SET status = 'REJECTED', reject_reason = 'Script banned by admin' WHERE script_id = $1 AND status = 'PENDING'`, [Number(id)]);
    }

    res.json({ ok: true, id: Number(id), is_banned: Boolean(is_banned) });
  } catch (err) {
    console.error('admin.toggleScriptBlock', err);
    res.status(500).json({ error: 'Failed to update script status' });
  }
};

exports.bulkToggleScripts = async (req, res) => {
  try {
    const { script_ids, is_banned, ban_reason } = req.body || {};
    if (!script_ids?.length) return res.status(400).json({ error: 'script_ids required' });

    const placeholders = script_ids.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `UPDATE scripts SET is_banned = $1, ban_reason = $2 WHERE id IN (${placeholders})`,
      [Boolean(is_banned), ban_reason || null, ...script_ids.map(Number)]
    );

    res.json({ ok: true, updated: script_ids.length });
  } catch (err) {
    console.error('admin.bulkToggleScripts', err);
    res.status(500).json({ error: 'Failed to bulk update scripts' });
  }
};

/* ── Master Qty Settings — per-script max lots ───────────────────────────────── */
exports.getMasterQtySettings = async (req, res) => {
  try {
    const { exchange } = req.query;
    let filter = '';
    const params = [];
    if (exchange) { params.push(exchange); filter = ` AND exchange = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT s.id, s.name, s.exchange, s.expiry, s.lot_size,
             s.max_lots, s.margin_per_lot, s.current_price,
             s.is_active, s.is_banned,
             (SELECT COUNT(*) FROM trades t WHERE t.script_id = s.id AND t.status = 'EXECUTED')::int AS total_trades
      FROM scripts s
      WHERE is_active = true ${filter}
      ORDER BY s.exchange, s.name
    `, params);

    // Exchange summary
    const exchSummary = rows.reduce((acc, r) => {
      if (!acc[r.exchange]) acc[r.exchange] = { exchange: r.exchange, count: 0, avg_max_lots: 0, total_lots: 0 };
      acc[r.exchange].count++;
      acc[r.exchange].total_lots += Number(r.max_lots || 0);
      acc[r.exchange].avg_max_lots = acc[r.exchange].total_lots / acc[r.exchange].count;
      return acc;
    }, {});

    res.json({ scripts: rows, exchange_summary: Object.values(exchSummary) });
  } catch (err) {
    console.error('admin.getMasterQtySettings', err);
    res.status(500).json({ error: 'Failed to load master qty settings' });
  }
};

exports.updateScriptMaxLots = async (req, res) => {
  try {
    const { updates } = req.body || {}; // [{ id, max_lots, margin_per_lot }]
    if (!updates?.length) return res.status(400).json({ error: 'updates array required' });

    for (const u of updates) {
      const sets = [];
      const params = [];
      if (u.max_lots !== undefined)      { params.push(Number(u.max_lots));      sets.push(`max_lots = $${params.length}`); }
      if (u.margin_per_lot !== undefined) { params.push(Number(u.margin_per_lot)); sets.push(`margin_per_lot = $${params.length}`); }
      if (sets.length) {
        params.push(Number(u.id));
        await db.query(`UPDATE scripts SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
    }

    res.json({ ok: true, updated: updates.length });
  } catch (err) {
    console.error('admin.updateScriptMaxLots', err);
    res.status(500).json({ error: 'Failed to update max lots' });
  }
};

exports.bulkSetExchangeMaxLots = async (req, res) => {
  try {
    const { exchange, max_lots, margin_per_lot } = req.body || {};
    if (!exchange || !max_lots) return res.status(400).json({ error: 'exchange and max_lots required' });

    const sets = [`max_lots = $1`];
    const params = [Number(max_lots)];
    if (margin_per_lot) { params.push(Number(margin_per_lot)); sets.push(`margin_per_lot = $${params.length}`); }
    params.push(exchange);

    const result = await db.query(`UPDATE scripts SET ${sets.join(', ')} WHERE exchange = $${params.length} AND is_active = true`, params);
    res.json({ ok: true, updated: result.rowCount, exchange, max_lots: Number(max_lots) });
  } catch (err) {
    console.error('admin.bulkSetExchangeMaxLots', err);
    res.status(500).json({ error: 'Failed to bulk set max lots' });
  }
};

exports.getIpLogs = async (req, res) => {
  try {
    const { start_date, end_date, user_id, ip } = req.query;
    const params = [];
    const wheres = ['1=1'];

    if (start_date) {
      params.push(start_date);
      wheres.push(`l.logged_at::date >= $${params.length}`);
    }
    if (end_date) {
      params.push(end_date);
      wheres.push(`l.logged_at::date <= $${params.length}`);
    }
    if (user_id) {
      params.push(Number(user_id));
      wheres.push(`l.user_id = $${params.length}`);
    }
    if (ip) {
      params.push(`%${ip}%`);
      wheres.push(`l.ip_address ILIKE $${params.length}`);
    }

    const { rows } = await db.query(`
      SELECT l.id, l.user_id, l.ip_address, l.user_agent, l.action, l.logged_at,
             u.username, u.full_name,
             COUNT(*) OVER (PARTITION BY l.user_id, l.ip_address) AS login_count
      FROM login_logs l
      JOIN users u ON u.id = l.user_id
      WHERE ${wheres.join(' AND ')}
      ORDER BY l.logged_at DESC
      LIMIT 2000
    `, params);

    res.json({ logs: rows });
  } catch (err) {
    console.error('admin.getIpLogs', err);
    res.status(500).json({ error: 'Failed to load IP logs' });
  }
};
