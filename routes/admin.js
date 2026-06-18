const router = require('express').Router();
const admin = require('../middleware/admin');
const ctrl = require('../controllers/adminController');

router.use(admin);
router.get('/stats', ctrl.stats);
router.get('/students', ctrl.listStudents);
router.get('/masters',  ctrl.listMasters);
router.get('/brokers',  ctrl.listBrokers);
router.post('/students', ctrl.createStudent);

router.patch('/students/:id', ctrl.updateStudent);
router.delete('/students/:id', ctrl.deleteStudent);
router.get('/students/:id/trades', ctrl.studentTrades);
router.post('/students/:id/credit', ctrl.creditStudent);

router.get('/all-trades', ctrl.getAllTrades);
router.patch('/trades/:id/cancel', ctrl.cancelTrade);
router.get('/rejections', ctrl.getRejections);
router.get('/settings', ctrl.getSettings);
router.post('/settings', ctrl.updateSettings);
router.patch('/scripts/:id', ctrl.updateScriptLot);
router.get('/ops-revenue', ctrl.getOpsRevenue);
router.get('/positions', ctrl.getPositions);
// Accounts section
router.get('/ledger',             ctrl.getLedger);
router.get('/accounts/cash-ledger',  ctrl.getCashLedger);
router.get('/accounts/cash-entries', ctrl.listCashEntries);
router.post('/accounts/cash-entry',  ctrl.createCashEntry);
router.get('/accounts/jv',           ctrl.listJV);
router.post('/accounts/jv',          ctrl.createJV);
router.get('/accounts/jv/:id',       ctrl.getJV);
router.get('/accounts/trial-balance',ctrl.getTrialBalance);

router.get('/trade-logs', ctrl.getTradeLogs);
router.get('/forensics/:userId', ctrl.getUserForensics);
router.get('/reports/weekly', ctrl.getWeeklyReport);
router.get('/reports/summary', ctrl.getSummaryReport);
router.get('/reports/script-wise', ctrl.getScriptWiseSummary);
router.get('/reports/margin-breakdown', ctrl.getMarginBreakdown);
router.post('/positions/close-all', ctrl.closeAllPositions);
router.post('/positions/:userId/close', ctrl.closeUserPositions);
router.post('/positions/rollover', ctrl.rollOverPositions);

// Utility Logs
router.get('/logs/trade-edit',    ctrl.getTradeEditLog);
router.get('/logs/user-edit',     ctrl.getUserEditLog);
router.get('/logs/ip',            ctrl.getIpLogs);
router.get('/logs/cash',          ctrl.getCashEditLog);
router.get('/logs/auto-squareup', ctrl.getAutoSquareUpLog);
router.get('/logs/cross-trades',  ctrl.getCrossTradeLog);
router.get('/logs/rejections',    ctrl.getRejectionLog);
router.post('/bulk-trade',        ctrl.executeBulkTrade);
router.get('/bill-filter',        ctrl.getBillFilter);


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

// Settings pages
router.get('/settings/quantity',          ctrl.getQuantitySettings);
router.post('/settings/quantity',         ctrl.updateQuantitySettings);
router.get('/settings/order-limits',      ctrl.getOrderLimits);
router.post('/settings/order-limit',      ctrl.updateOrderLimit);
router.get('/settings/block-scripts',     ctrl.getBlockAllowScripts);
router.patch('/settings/block-scripts/:id', ctrl.toggleScriptBlock);
router.post('/settings/block-scripts/bulk', ctrl.bulkToggleScripts);
router.get('/settings/master-qty',        ctrl.getMasterQtySettings);
router.post('/settings/master-qty',       ctrl.updateScriptMaxLots);
router.post('/settings/master-qty/bulk',  ctrl.bulkSetExchangeMaxLots);

module.exports = router;

