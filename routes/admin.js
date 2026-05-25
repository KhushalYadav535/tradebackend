const router = require('express').Router();
const admin = require('../middleware/admin');
const ctrl = require('../controllers/adminController');

router.use(admin);
router.get('/stats', ctrl.stats);
router.get('/students', ctrl.listStudents);
router.post('/students', ctrl.createStudent);
router.patch('/students/:id', ctrl.updateStudent);
router.delete('/students/:id', ctrl.deleteStudent);
router.get('/students/:id/trades', ctrl.studentTrades);

module.exports = router;
