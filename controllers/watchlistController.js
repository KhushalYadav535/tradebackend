const db = require('../db');

// GET /api/watchlist — return logged-in user's watchlist
async function getWatchlist(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, segment, name, expiry, option_type, strike, created_at
       FROM watchlist
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/watchlist — add a script
async function addWatchlist(req, res, next) {
  try {
    const { segment, name, expiry, option_type, strike } = req.body;
    if (!segment || !name) return res.status(400).json({ error: 'segment and name required' });

    const { rows } = await db.query(
      `INSERT INTO watchlist (user_id, segment, name, expiry, option_type, strike)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, segment, name, expiry, option_type, strike) DO NOTHING
       RETURNING id, segment, name, expiry, option_type, strike, created_at`,
      [req.user.id, segment, name, expiry || null, option_type || null, strike || null]
    );
    res.status(201).json({ item: rows[0] || null });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/watchlist/:id — remove a script by DB id
async function removeWatchlist(req, res, next) {
  try {
    await db.query(
      `DELETE FROM watchlist WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/watchlist — clear entire watchlist
async function clearWatchlist(req, res, next) {
  try {
    await db.query(`DELETE FROM watchlist WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getWatchlist, addWatchlist, removeWatchlist, clearWatchlist };
