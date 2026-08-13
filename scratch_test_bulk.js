const twitterEngine = require('./server/twitterEngine.js');

async function testBulk() {
  const links = [
    'https://x.com/_Naylovee/status/2087695295446421525',
    'https://x.com/Switzerland_aib/status/2087615099087253940'
  ];

  console.log("Testando extração em massa para:", links);
  const results = await twitterEngine.extractBulkLinksData(links);
  console.log("Resultados Obtidos:", JSON.stringify(results, null, 2));
}

testBulk().catch(console.error);
