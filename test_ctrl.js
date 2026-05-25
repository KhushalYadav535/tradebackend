const ctrl = require('./controllers/scriptsController');
const req = { params: { symbol: 'NIFTY' }, query: {} };
const res = { 
  json: (data) => { console.log('res.json called'); process.exit(0); },
  status: (code) => { console.log('res.status', code); return res; }
};
console.log('calling optionChain');
ctrl.optionChain(req, res).catch(console.error);
