const fs = require('fs');

const testInput = `izzanrafiqin:32PXr7YoQmIy:izzanraafiqin@yahoo.com:32PXr7YoQmIy:c63ea37b93a90d6daed82908d6a04898427e65be
rachid_8:ZUfdWCm4pc1I:jabsonchaz17@yahoo.com:ZUfdWCm4pc1I:0db4bc2a6969817b9b52a5543cf2cc228f660439
cutie_julz:ECd16uJyaYQw:jhumer_21@yahoo.com:ECd16uJyaYQw:92343e5aeeca744ebba498cff223ee76130662b6
jheszahMu:fcLuC7f16q7T:jheszah_labx@yahoo.com:fcLuC7f16q7T:b0bf5a27406eee8708e97d39bd5c8c03641a3008`;

function parseInputTokens(input) {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : String(input).split(/[\r\n]+/);
  const items = [];
  const seenTokens = new Set();

  for (let rawItem of rawList) {
    const line = String(rawItem).trim();
    if (!line) continue;

    let token = null;
    let username = null;

    if (line.includes(':')) {
      const parts = line.split(':').map(p => p.trim());
      for (let i = parts.length - 1; i >= 0; i--) {
        const hexMatch = parts[i].match(/([a-f0-9]{40})/i);
        if (hexMatch) {
          token = hexMatch[1].toLowerCase();
          break;
        }
      }

      if (parts[0] && !parts[0].includes('@') && !parts[0].match(/^[a-f0-9]{40}$/i)) {
        username = parts[0].replace(/^@/, '').trim();
      }
    }

    if (!token) {
      const generalHexMatch = line.match(/([a-f0-9]{40})/i);
      if (generalHexMatch) {
        token = generalHexMatch[1].toLowerCase();
      } else {
        const cleanToken = line.replace(/[^a-f0-9]/gi, '');
        if (cleanToken.length >= 32) {
          token = cleanToken.toLowerCase();
        }
      }
    }

    if (token && !seenTokens.has(token)) {
      seenTokens.add(token);
      items.push({
        token: token,
        username: username || null
      });
    }
  }

  return items;
}

const parsed = parseInputTokens(testInput);
console.log("Resultado do Parser com os Dados do Usuário:\n", parsed);
