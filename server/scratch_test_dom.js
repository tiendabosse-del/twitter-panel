const puppeteer = require('puppeteer-core');
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
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // 1. Abre x.com primeiro para estabelecer sessão de cookies no domínio
  await page.goto('https://x.com', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  if (token) {
    const expires = Math.floor(Date.now() / 1000) + 86400 * 365;
    await page.setCookie(
      { name: 'auth_token', value: token, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires },
      { name: 'auth_token', value: token, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires }
    );
  }

  console.log(`Navegando para o tweet: ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));

  console.log("URL Final:", page.url());

  const domData = await page.evaluate(() => {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return { error: "article não encontrado", text: document.body ? document.body.innerText.substring(0, 300) : '' };

    const fullText = article.innerText;
    const analytics = article.querySelector('a[href*="/analytics"]');
    const analyticsText = analytics ? analytics.innerText : '';

    return { fullText, analyticsText };
  });

  console.log("Resultado da Raspagem DOM:", domData);

  await browser.close();
})();
