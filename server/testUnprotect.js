const puppeteer = require('puppeteer-core');

(async () => {
  try {
    console.log('Testando seletores de https://x.com/settings/audience_and_tagging...');
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'auth_token', value: '4935f4a94133184f1966f846d02acde31c87f39e', domain: '.x.com', path: '/', secure: true, httpOnly: true });

    console.log('Navegando para settings/audience_and_tagging...');
    await page.goto('https://x.com/settings/audience_and_tagging', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    console.log('URL atual:', page.url());

    const pageInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, button, div[role="checkbox"], div[role="switch"]'));
      const text = document.body.innerText;
      const isProtectedText = text.includes('Protect your posts') || text.includes('Proteger seus posts');
      
      const elements = inputs.map(el => ({
        tag: el.tagName,
        type: el.type,
        role: el.getAttribute('role'),
        checked: el.checked || el.getAttribute('aria-checked'),
        ariaLabel: el.getAttribute('aria-label'),
        parentText: el.parentElement ? el.parentElement.textContent.trim().substring(0, 50) : ''
      }));

      return { isProtectedText, elements };
    });

    console.log('Resultado da página de audiência:', JSON.stringify(pageInfo, null, 2));

    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
