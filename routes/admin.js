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

router.get('/all-trades', ctrl.getAllTrades);
router.get('/rejections', ctrl.getRejections);
router.get('/settings', ctrl.getSettings);
router.post('/settings', ctrl.updateSettings);
router.patch('/scripts/:id', ctrl.updateScriptLot);
router.get('/ops-revenue', ctrl.getOpsRevenue);
router.get('/positions', ctrl.getPositions);
router.get('/ledger', ctrl.getLedger);
router.get('/trade-logs', ctrl.getTradeLogs);

// Indices Master routes
router.get('/indices', ctrl.listIndices);
router.post('/indices', ctrl.createIndex);
router.patch('/indices/:id', (req, res) => {
  req.body.id = Number(req.params.id);
  ctrl.updateIndices(req, res);
});
router.delete('/indices/:id', ctrl.deleteIndex);

// Script Master routes
router.get('/script-master', ctrl.listScriptMaster);
router.post('/script-master', ctrl.createScript);
router.patch('/script-master/:id', (req, res) => {
  req.body.id = Number(req.params.id);
  ctrl.updateScriptActive(req, res);
});
router.delete('/script-master/:id', ctrl.deleteScript);

module.exports = router;
