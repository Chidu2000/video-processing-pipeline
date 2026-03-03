const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');

const ffmpeg = require('fluent-ffmpeg');

const RESOLUTIONS = [
  { name: '360p', width: 480, height: 360 },
  { name: '480p', width: 858, height: 480 },
  { name: '720p', width: 1280, height: 720 },
];

const s3client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
});

const BUCKET = process.env.BUCKET;
const KEY = process.env.KEY;

async function downloadToFile(resultBody, outputPath) {
  if (!resultBody) {
    throw new Error('S3 returned an empty body');
  }

  if (typeof resultBody.pipe === 'function') {
    await pipeline(resultBody, fs.createWriteStream(outputPath));
    return;
  }

  if (typeof resultBody.transformToByteArray === 'function') {
    const bytes = await resultBody.transformToByteArray();
    await fsp.writeFile(outputPath, Buffer.from(bytes));
    return;
  }

  throw new Error('Unsupported S3 body type for download');
}

async function transcodeAndUpload(originalVideoPath, resolution) {
  const output = `video-${resolution.name}.mp4`;

  await new Promise((resolve, reject) => {
    ffmpeg(originalVideoPath)
      .output(output)
      .withVideoCodec('libx264')
      .withAudioCodec('aac')
      .withSize(`${resolution.width}x${resolution.height}`)
      .on('error', reject)
      .on('end', async () => {
        try {
          const putcommand = new PutObjectCommand({
            Bucket: 'production.chidambar.com',
            Key: output,
            Body: fs.createReadStream(path.resolve(output)),
          });
          await s3client.send(putcommand);
          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .format('mp4')
      .run();
  });
}

async function init() {
  if (!BUCKET || !KEY) {
    throw new Error('Missing required environment variables BUCKET and KEY');
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: KEY,
  });

  const result = await s3client.send(command);
  const originalFilePath = 'original-video.mp4';
  await downloadToFile(result.Body, originalFilePath);

  const originalVideoPath = path.resolve(originalFilePath);
  await Promise.all(RESOLUTIONS.map((resolution) => transcodeAndUpload(originalVideoPath, resolution)));
}

init().catch((err) => {
  console.error('Transcoding pipeline failed:', err);
  process.exit(1);
});
