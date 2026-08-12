const puppeteer = require('./server/node_modules/puppeteer');
const path = require('path');
const fs = require('fs');

function getChromeExecutable() {
  const localApp = process.env.LOCALAPPDATA || 'C:\\Users\\Pichau\\AppData\\Local';
  const paths = [
    path.join(localApp, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

(async () => {
  const url = "https://x.com/kishorekkk63/status/2087569134552752268";
  const token = "4935f4a94133184f1966f846d02acde31c87f39e";

  const browser = await puppeteer.launch({
    executablePath: getChromeExecutable(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  if (token) {
    const expires = Math.floor(Date.now() / 1000) + 86400 * 365;
    await page.setCookie(
      { name: 'auth_token', value: token, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires },
      { name: 'auth_token', value: token, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires }
    );
  }

  console.log(`Navegando para ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise(r => setTimeout(r, 4000));

  console.log("URL Final:", page.url());
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 500) : '');
  console.log("Texto do Body:\n", bodyText);

  await browser.close();
})();
