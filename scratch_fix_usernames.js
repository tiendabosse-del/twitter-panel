const fs = require('fs');
const path = require('path');

const accPath = path.join(__dirname, 'server', 'accounts.json');
if (fs.existsSync(accPath)) {
  const accounts = JSON.parse(fs.readFileSync(accPath, 'utf8'));

  const fixes = {
    'c63ea37b93a90d6daed82908d6a04898427e65be': 'izzanrafiqin',
    'b0bf5a27406eee8708e97d39bd5c8c03641a3008': 'jheszahMu'
  };

  let count = 0;
  for (let acc of accounts) {
    if (fixes[acc.token]) {
      acc.username = fixes[acc.token];
      acc.name = fixes[acc.token];
      count++;
    }
  }

  fs.writeFileSync(accPath, JSON.stringify(accounts, null, 2), 'utf8');
  console.log(`✓ ${count} contas corrigidas com seu @username real do Twitter!`);
}
