const ctrl = require('./controllers/scriptsController');
const req = { params: {}, query: {} };
const res = { 
  json: (data) => { console.log('res.json called, scripts:', data?.scripts?.length); process.exit(0); },
  status: (code) => { console.log('res.status', code); return res; }
};
console.log('calling list');
ctrl.list(req, res).catch(console.error);
