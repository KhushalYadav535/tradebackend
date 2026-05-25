const db = require('../db');

exports.list = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.buy_qty, p.sell_qty, p.avg_buy_price, p.avg_sell_price, p.updated_at,
              s.id AS script_id, s.name AS script, s.exchange, s.lot_size, s.current_price
       FROM positions p
       JOIN scripts s ON s.id = p.script_id
       WHERE p.user_id = $1
       ORDER BY p.updated_at DESC`,
      [req.user.id]
    );

    const positions = rows.map((p) => {
      const buyQty = Number(p.buy_qty || 0);
      const sellQty = Number(p.sell_qty || 0);
      const ltp = Number(p.current_price || 0);
      const avgBuy = Number(p.avg_buy_price || 0);
      const avgSell = Number(p.avg_sell_price || 0);
      const netQty = buyQty - sellQty;

      // P&L = realized (matched buy↔sell) + unrealized on net qty.
      const matched = Math.min(buyQty, sellQty);
      const realized = matched * (avgSell - avgBuy);
      const unrealized = netQty > 0
        ? netQty * (ltp - avgBuy)
        : netQty < 0
          ? Math.abs(netQty) * (avgSell - ltp)
          : 0;
      const pnl = Number((realized + unrealized).toFixed(2));

      return {
        ...p,
        buy_qty: buyQty,
        sell_qty: sellQty,
        net_qty: netQty,
        avg_price: netQty > 0 ? avgBuy : netQty < 0 ? avgSell : 0,
        ltp,
        pnl,
      };
    });

    const totals = positions.reduce(
      (acc, p) => {
        acc.pnl += p.pnl;
        acc.buy_qty += p.buy_qty;
        acc.sell_qty += p.sell_qty;
        if (p.net_qty !== 0) acc.open += 1;
        return acc;
      },
      { pnl: 0, buy_qty: 0, sell_qty: 0, open: 0 }
    );
    totals.pnl = Number(totals.pnl.toFixed(2));

    res.json({ positions, totals });
  } catch (err) {
    console.error('positions.list', err);
    res.status(500).json({ error: 'Failed to load positions' });
  }
};
