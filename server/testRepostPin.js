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

    await page.goto('https://x.com/BobbyRichie1', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    const caretBtn = await page.$('[data-testid="caret"]');
    if (caretBtn) {
      await caretBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      const menuItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="menuitem"], [data-testid="pin"]')).map(el => ({
          testId: el.getAttribute('data-testid'),
          text: el.textContent.trim()
        }));
      });

      console.log('Menu items after clicking caret:', JSON.stringify(menuItems, null, 2));
    }

    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
