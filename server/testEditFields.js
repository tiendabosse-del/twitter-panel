const puppeteer = require('puppeteer-core');

(async () => {
  try {
    console.log('Testando campos de https://x.com/settings/profile...');
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'auth_token', value: '4935f4a94133184f1966f846d02acde31c87f39e', domain: '.x.com', path: '/', secure: true, httpOnly: true });

    await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea[name="description"]', { timeout: 20000 });

    const fieldsInfo = await page.evaluate(() => {
      const bioEl = document.querySelector('textarea[name="description"]');
      const locationEl = document.querySelector('input[name="location"]');
      const websiteEl = document.querySelector('input[name="url"]');
      const saveBtn = document.querySelector('[data-testid="Profile_Save_Button"]');

      return {
        hasBio: !!bioEl,
        bioValue: bioEl ? bioEl.value : null,
        hasLocation: !!locationEl,
        locationValue: locationEl ? locationEl.value : null,
        hasWebsite: !!websiteEl,
        websiteValue: websiteEl ? websiteEl.value : null,
        hasSaveBtn: !!saveBtn
      };
    });

    console.log('Campos de perfil encontrados:', JSON.stringify(fieldsInfo, null, 2));
    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
