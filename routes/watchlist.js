const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/watchlistController');

router.use(auth);
router.get('/', ctrl.getWatchlist);
router.post('/', ctrl.addWatchlist);
router.delete('/clear', ctrl.clearWatchlist);
router.delete('/:id', ctrl.removeWatchlist);

module.exports = router;
