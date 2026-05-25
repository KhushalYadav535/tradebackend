const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/tradesController');

router.use(auth);
router.post('/', ctrl.place);
router.get('/', ctrl.list);
router.get('/editlog', ctrl.editLog);
router.get('/rejectionlog', ctrl.rejectionLog);

module.exports = router;
