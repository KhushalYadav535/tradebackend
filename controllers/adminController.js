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
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.full_name, u.balance, u.exposure, u.is_active, u.role, u.created_at,
              (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id AND t.status='EXECUTED')::int AS trade_count
       FROM users u
       ORDER BY u.created_at DESC`
    );
    res.json({ students: rows });
  } catch (err) {
    console.error('admin.listStudents', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
};

exports.createStudent = async (req, res) => {
  const { username, password, full_name, balance } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-50 chars, letters/digits/_.-' });
  }
  try {
    const exists = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, 10);
    const initialBalance = Number(balance) > 0 ? Number(balance) : 500000;
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, full_name, role, balance)
       VALUES ($1,$2,$3,'user',$4)
       RETURNING id, username, full_name, balance, exposure, is_active, created_at`,
      [username, hash, full_name || username, initialBalance]
    );
    const student = rows[0];
    await db.query(
      `INSERT INTO ledger (user_id, description, credit, balance)
       VALUES ($1, 'Opening Balance (admin-created)', $2, $2)`,
      [student.id, initialBalance]
    );
    res.json({ student });
  } catch (err) {
    console.error('admin.createStudent', err);
    res.status(500).json({ error: 'Failed to create student' });
  }
};

exports.updateStudent = async (req, res) => {
  const id = Number(req.params.id);
  const { full_name, balance, is_active, password, role } = req.body || {};
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
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id=$${i} RETURNING id, username, full_name, balance, exposure, is_active`,
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
    const { rows } = await db.query(`
      SELECT t.id, t.trade_type, t.quantity, t.price, t.total_value, t.status, t.reject_reason, t.created_at,
             s.name AS script, s.exchange,
             u.username, u.full_name
      FROM trades t
      JOIN scripts s ON s.id = t.script_id
      JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC
      LIMIT 500
    `);
    res.json({ trades: rows });
  } catch (err) {
    console.error('admin.getAllTrades', err);
    res.status(500).json({ error: 'Failed to load trades' });
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

