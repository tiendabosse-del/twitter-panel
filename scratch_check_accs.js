const fs = require('fs');
const path = require('path');

const accPath = path.join(__dirname, 'server', 'accounts.json');
const accUserPath = path.join(__dirname, 'server', 'accounts_user.json');

if (fs.existsSync(accPath)) {
  const accounts = JSON.parse(fs.readFileSync(accPath, 'utf8'));
  const accUsernames = accounts.filter(a => a.username && a.username.startsWith('acc_'));
  console.log(`accounts.json possui ${accounts.length} contas (${accUsernames.length} com username genérico acc_...)`);
}

if (fs.existsSync(accUserPath)) {
  const accountsUser = JSON.parse(fs.readFileSync(accUserPath, 'utf8'));
  const accUsernames = accountsUser.filter(a => a.username && a.username.startsWith('acc_'));
  console.log(`accounts_user.json possui ${accountsUser.length} contas (${accUsernames.length} com username genérico acc_...)`);
}
