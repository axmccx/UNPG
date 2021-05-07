const throng = require('throng');
const Queue = require('bull');
const crypto = require('crypto');
const path = require('path');
const azureStorage = require('azure-storage');
const { generatePdf, generateMpc } = require('./generators');
const { request } = require('./database/models');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const workers = process.env.WEB_CONCURRENCY || 1;
const maxJobsPerWorker = 1;
const blobService = azureStorage.createBlobService();
const containerName = process.env.AZURE_RESULTS_CONTAINER_NAME;

async function cachedCopyExists(hash) {
  return request.count({ where: { hash, is_download_available: true } })
    .then((count) => (count !== 0));
}

function start() {
  const workQueue = new Queue('work', REDIS_URL);
  workQueue.process(maxJobsPerWorker, async (job, done) => {
    let result;
    let generateFunc;
    let fileExtension;

    if (job.data.generateType === 'pdf') {
      generateFunc = generatePdf;
      fileExtension = '.pdf';
    } else if (job.data.generateType === 'mpc') {
      generateFunc = generateMpc;
      fileExtension = '.zip';
    }

    const dataToHash = { ...job.data };
    delete dataToHash.sessionID;
    delete dataToHash.requestID;
    const hash = crypto
      .createHash('sha1')
      .update(JSON.stringify(dataToHash))
      .digest('hex');

    if (await cachedCopyExists(hash)) {
      console.log('Found cached copy!');
      job.log('Found cached copy!');
      job.progress(95);
      result = {
        filepath: `./tmp/${hash}${fileExtension}`,
        hash,
        requestID: job.data.requestID,
      };
      done(null, result);
    } else {
      result = await generateFunc(job, hash);
      console.log('Uploading file to Azure...');
      job.log('Uploading file to Azure...');
      job.progress(95);
      blobService.createBlockBlobFromLocalFile(
        containerName,
        path.basename(result.filepath),
        result.filepath,
        (err) => {
          if (err) {
            console.log('Azure upload error!!!');
          }
          done(null, result);
        },
      );
    }
  });
}

throng({ workers, start });
