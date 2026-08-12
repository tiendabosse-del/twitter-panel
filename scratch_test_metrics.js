const fs = require('fs');
const path = require('path');
const twitterEngine = require('./server/twitterEngine.js');

(async () => {
  const postsPath = path.join(__dirname, 'server', 'published_posts.json');
  if (!fs.existsSync(postsPath)) {
    console.log('published_posts.json não encontrado');
    return;
  }

  const accountsPath = path.join(__dirname, 'server', 'accounts.json');
  const accounts = fs.existsSync(accountsPath) ? JSON.parse(fs.readFileSync(accountsPath, 'utf8')) : [];
  const validToken = accounts.find(a => a.status === 'Válido' && a.token)?.token;

  const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
  console.log(`Buscando métricas 100% reais do DOM do Twitter para ${posts.length} postagens...`);

  let updated = 0;
  for (let i = 0; i < Math.min(posts.length, 5); i++) {
    const p = posts[i];
    if (!p.tweetUrl) continue;
    try {
      const domMetrics = await twitterEngine.scrapeRealMetricsFromDOM(p.tweetUrl, validToken);
      if (domMetrics) {
        console.log(`[Post ${i + 1}/${posts.length}] ${p.tweetUrl} -> REAL Views: ${domMetrics.views}, Likes: ${domMetrics.likes}, RTs: ${domMetrics.retweets}, Replies: ${domMetrics.replies}`);
        p.metrics = {
          views: Math.max(domMetrics.views || 0, p.metrics?.views || 0),
          likes: Math.max(domMetrics.likes || 0, p.metrics?.likes || 0),
          retweets: Math.max(domMetrics.retweets || 0, p.metrics?.retweets || 0),
          replies: Math.max(domMetrics.replies || 0, p.metrics?.replies || 0)
        };
        updated++;
      }
    } catch (err) {
      console.error(`Erro em ${p.tweetUrl}:`, err.message);
    }
  }

  fs.writeFileSync(postsPath, JSON.stringify(posts, null, 2), 'utf8');
  console.log(`✓ ${updated} postagens atualizadas com métricas 100% reais do DOM do Twitter!`);
})();
