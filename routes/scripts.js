const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/scriptsController');

router.use(auth);
router.get('/', ctrl.list);
router.get('/banned', ctrl.banned);
router.get('/maxqty', ctrl.maxQty);

module.exports = router;
