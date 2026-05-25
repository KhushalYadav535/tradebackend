const db = require('../db');

exports.list = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, description, debit, credit, balance, trade_id, created_at
       FROM ledger
       WHERE user_id = $1
       ORDER BY created_at ASC, id ASC`,
      [req.user.id]
    );

    const opening = rows.length ? Number(rows[0].balance) - Number(rows[0].credit || 0) + Number(rows[0].debit || 0) : 0;
    const userRes = await db.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
    const current = userRes.rows[0] ? Number(userRes.rows[0].balance) : 0;

    const stats = {
      opening_balance: rows.length ? Number(rows[0].balance) : current,
      current_balance: current,
      net_pnl: Number((current - (rows.length ? Number(rows[0].balance) : current)).toFixed(2)),
    };

    res.json({ entries: rows.reverse(), stats });
  } catch (err) {
    console.error('ledger.list', err);
    res.status(500).json({ error: 'Failed to load ledger' });
  }
};
