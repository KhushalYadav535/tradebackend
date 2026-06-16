const db = require('./db');
async function run() {
  await db.query("UPDATE scripts SET current_price = 300, prev_close = 300 WHERE name = 'NATURALGAS'");
  await db.query("UPDATE scripts SET current_price = 72000, prev_close = 72000 WHERE name = 'GOLD'");
  await db.query("UPDATE scripts SET current_price = 6500, prev_close = 6500 WHERE name = 'CRUDEOIL'");
  await db.query("UPDATE scripts SET current_price = 90000, prev_close = 90000 WHERE name = 'SILVER'");
  console.log('Updated prices successfully');
  process.exit(0);
}
run().catch(console.error);
