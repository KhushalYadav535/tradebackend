const auth = require('./auth');

function adminMiddleware(req, res, next) {
  auth(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = adminMiddleware;
