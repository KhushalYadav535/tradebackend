const nseService = require('./services/nseService');
nseService.getOptionChain('NIFTY').then(data => {
  console.log('Success', !!data);
  process.exit(0);
}).catch(err => {
  console.error('Error', err);
  process.exit(1);
});
