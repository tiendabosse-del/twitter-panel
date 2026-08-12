const puppeteer = require('puppeteer-core');

(async () => {
  try {
    console.log('Testando busca do tweet principal no perfil...');
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'auth_token', value: '4935f4a94133184f1966f846d02acde31c87f39e', domain: '.x.com', path: '/', secure: true, httpOnly: true });

    await page.goto('https://x.com/adeelmcb', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    // Testa identificar o tweet principal que contém mídias ou texto sem ser "Replying to"
    const mainTweetInfo = await page.evaluate(() => {
      const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      for (let i = 0; i < tweets.length; i++) {
        const t = tweets[i];
        const text = t.textContent || '';
        const isReplyHeader = text.includes('Replying to') || text.includes('Respondendo a');
        const hasMedia = !!t.querySelector('video, img[src*="media"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"]');

        if (!isReplyHeader || hasMedia) {
          return {
            index: i,
            textSnippet: text.substring(0, 80),
            hasMedia,
            isReplyHeader
          };
        }
      }
      return null;
    });

    console.log('Tweet principal identificado:', mainTweetInfo);
    await browser.close();
  } catch (e) {
    console.error('Erro:', e);
  }
})();
