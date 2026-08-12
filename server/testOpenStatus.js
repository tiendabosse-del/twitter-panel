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

    await page.goto('https://x.com/BobbyRichie1/status/2087169653466452155', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 20000 });

    // Clica no botão de resposta no status
    const replyBtn = await page.$('[data-testid="reply"]');
    if (replyBtn) {
      await replyBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      const hasArea = await page.evaluate(() => !!document.querySelector('[data-testid="tweetTextarea_0"]'));
      console.log('Após clicar em reply, tweetTextarea_0 encontrado:', hasArea);
    }

    // Procura caret na página de status
    const caret = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="caret"]') || document.querySelector('[aria-label*="Mais"]') || document.querySelector('[aria-label*="More"]');
      return !!btn;
    });
    console.log('Botão Caret/Mais encontrado no status:', caret);

    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
