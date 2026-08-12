const puppeteer = require('puppeteer-core');

(async () => {
  try {
    console.log('Iniciando teste do Puppeteer...');
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.setCookie({
      name: 'auth_token',
      value: '4935f4a94133184f1966f846d02acde31c87f39e',
      domain: '.x.com',
      path: '/',
      secure: true,
      httpOnly: true
    });

    console.log('Navegando para x.com/compose/post...');
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise(r => setTimeout(r, 4000));

    console.log('URL atual:', page.url());

    const hasTextarea = await page.evaluate(() => {
      return !!document.querySelector('[data-testid="tweetTextarea_0"]');
    });

    const hasTweetButton = await page.evaluate(() => {
      return !!document.querySelector('[data-testid="tweetButton"]');
    });

    console.log('Textarea 0 encontrado:', hasTextarea);
    console.log('Botão de tweet encontrado:', hasTweetButton);

    await browser.close();
  } catch (e) {
    console.error('Erro de teste:', e);
  }
})();
