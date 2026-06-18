const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

exports.login = async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, username, password_hash, full_name, role, is_active, balance, exposure
       FROM users WHERE username = $1`,
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // ── Capture real client IP ──────────────────────────────
    const rawIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      req.ip ||
      'unknown';
    // Strip IPv6 prefix ::ffff: if present (e.g. ::ffff:192.168.1.1 → 192.168.1.1)
    let clientIp = rawIp.replace(/^::ffff:/, '');
    if (clientIp === '::1') clientIp = '127.0.0.1'; // Make local IPv6 look like standard localhost
    
    const userAgent = req.headers['user-agent'] || '';

    // Fire-and-forget — don't block response
    db.query(
      `INSERT INTO login_logs (user_id, ip_address, user_agent, action) VALUES ($1, $2, $3, 'login')`,
      [user.id, clientIp, userAgent]
    ).catch(e => console.warn('login_log insert failed:', e.message));
    // ────────────────────────────────────────────────────────

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        balance: user.balance,
        exposure: user.exposure,
      },
    });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
};


exports.logout = async (req, res) => {
  res.json({ ok: true });
};

exports.me = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, full_name, role, balance, exposure
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('me error', err);
    res.status(500).json({ error: 'Failed to load user' });
  }
};
