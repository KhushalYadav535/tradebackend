const db = require('../db');

exports.me = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, full_name, role, balance, exposure
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('users.me', err);
    res.status(500).json({ error: 'Failed to load user' });
  }
};
