const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

function getR2Config() {
  const endpoint = (process.env.CLOUDFLARE_R2_ENDPOINT || '').trim() || 'https://c790da90e69fc0a33754e919cc0b5225.r2.cloudflarestorage.com';
  let accessKeyId = (process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '').trim().replace(/^["']|["']$/g, '');
  if (!accessKeyId || accessKeyId.length !== 32) {
    accessKeyId = '0e35bab3dd753090300ec0b203283a26';
  }
  const secretAccessKey = (process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '').trim().replace(/^["']|["']$/g, '') || 'e7d8aec9f2a7424b1902c7c6641a61c4a853f7a8bf58a6f45f944fd7e5d48c6d';
  const bucketName = (process.env.CLOUDFLARE_R2_BUCKET_NAME || '').trim() || 'instagram-media';
  let publicUrl = (process.env.CLOUDFLARE_R2_PUBLIC_URL || '').trim() || 'https://pub-6d90523062f648aeb0731319871f16d0.r2.dev';
  if (publicUrl.endsWith('/')) publicUrl = publicUrl.slice(0, -1);

  return { endpoint, accessKeyId, secretAccessKey, bucketName, publicUrl };
}

function getR2Client() {
  const config = getR2Config();
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Envia um arquivo local ou buffer para o Cloudflare R2 e retorna a URL publica HTTPS.
 */
async function uploadFileToR2(filePathOrBuffer, originalName, mimeType) {
  const config = getR2Config();
  const client = getR2Client();

  let bodyBuffer;
  if (Buffer.isBuffer(filePathOrBuffer)) {
    bodyBuffer = filePathOrBuffer;
  } else {
    bodyBuffer = await fs.promises.readFile(filePathOrBuffer);
  }

  const ext = path.extname(originalName) || (mimeType && mimeType.includes('video') ? '.mp4' : '.png');
  const fileName = `twitter-uploads/${Date.now()}-${Math.random().toString(36).substring(2, 9)}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: fileName,
      Body: bodyBuffer,
      ContentType: mimeType || 'application/octet-stream',
    })
  );

  return `${config.publicUrl}/${fileName}`;
}

module.exports = {
  uploadFileToR2,
  getR2Config,
};
