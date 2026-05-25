const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/usersController');

router.use(auth);
router.get('/me', ctrl.me);

module.exports = router;
