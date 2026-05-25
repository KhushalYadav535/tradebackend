const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/ledgerController');

router.use(auth);
router.get('/', ctrl.list);

module.exports = router;
