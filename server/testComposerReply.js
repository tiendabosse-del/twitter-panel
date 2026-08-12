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

    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 20000 });

    const whoCanReplyBtn = await page.$('[data-testid="whoCanReply"], [aria-label*="responder"], [aria-label*="reply"]');
    if (whoCanReplyBtn) {
      await whoCanReplyBtn.click();
      await new Promise(r => setTimeout(r, 1500));

      const items = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('div[role="button"], span, div')).map(el => ({
          testId: el.getAttribute('data-testid'),
          ariaLabel: el.getAttribute('aria-label'),
          text: el.textContent.trim()
        })).filter(x => x.text && (x.text.includes('Everyone') || x.text.includes('Verified') || x.text.includes('follow') || x.text.includes('mention') || x.text.includes('responder') || x.text.includes('verificadas')));
      });

      console.log('Opções no modal de quem pode responder:', JSON.stringify(items, null, 2));
    }

    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
