const puppeteer = require('puppeteer-core');

(async () => {
  try {
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'auth_token', value: '4935f4a94133184f1966f846d02acde31c87f39e', domain: '.x.com', path: '/', secure: true, httpOnly: true });

    await page.goto('https://x.com/settings/audience_and_tagging', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="checkbox"]', { timeout: 20000 });

    const isProtected = await page.evaluate(() => {
      const checkbox = document.querySelector('input[type="checkbox"]');
      return checkbox ? checkbox.checked : false;
    });

    console.log('Status da proteção da conta:', isProtected ? 'PROTEGIDA (🔒)' : 'PÚBLICA (🔓)');
    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
