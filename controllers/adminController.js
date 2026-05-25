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
      `SELECT u.id, u.username, u.full_name, u.balance, u.exposure, u.is_active, u.created_at,
              (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id AND t.status='EXECUTED')::int AS trade_count
       FROM users u
       WHERE u.role = 'user'
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
  const { full_name, balance, is_active, password } = req.body || {};
  try {
    const cur = await db.query(`SELECT * FROM users WHERE id=$1 AND role='user'`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Student not found' });

    const sets = [];
    const vals = [];
    let i = 1;

    if (typeof full_name === 'string') { sets.push(`full_name=$${i++}`); vals.push(full_name); }
    if (typeof is_active === 'boolean') { sets.push(`is_active=$${i++}`); vals.push(is_active); }
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
    const { rowCount } = await db.query(`DELETE FROM users WHERE id=$1 AND role='user'`, [id]);
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
