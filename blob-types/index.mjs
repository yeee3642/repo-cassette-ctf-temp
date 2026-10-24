import https from 'node:https';
import {createHash} from 'node:crypto';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const nelType = 'application/json\u0085';
const stamp = process.env.GITHUB_RUN_ID;

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {headers: {'user-agent': 'blob-type-matrix'}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function rawHeaderHex(response, wanted) {
  const lower = wanted.toLowerCase();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === lower) {
      return Buffer.from(response.rawHeaders[i + 1], 'latin1').toString('hex');
    }
  }
  return null;
}

async function upload(blob, kind, payload) {
  const headers = {blobContentType: nelType};
  if (kind === 'block') {
    await blob.getBlockBlobClient().uploadData(payload, {blobHTTPHeaders: headers});
  } else if (kind === 'append') {
    const target = blob.getAppendBlobClient();
    await target.create({blobHTTPHeaders: headers});
    await target.appendBlock(payload, payload.length);
  } else if (kind === 'page') {
    const target = blob.getPageBlobClient();
    await target.create(payload.length, {blobHTTPHeaders: headers});
    await target.uploadPages(payload, 0, payload.length);
  }
}

for (const kind of ['block', 'append', 'page']) {
  const raw = Buffer.from('{"kind":"' + kind + '"}');
  const payload = kind === 'page'
    ? Buffer.concat([raw, Buffer.alloc(512 - raw.length, 0x20)])
    : raw;
  const name = `blob-type-${kind}-${stamp}`;
  const report = {kind};
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    const uploadUrl = new URL(created.signedUploadUrl);
    report.uploadSp = uploadUrl.searchParams.get('sp');
    await upload(new BlobClient(created.signedUploadUrl), kind, payload);
    const digest = createHash('sha256').update(payload).digest('hex');
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(payload.length),
      hash: StringValue.create({value: `sha256:${digest}`}),
    });
    const signed = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const currentUrl = new URL(signed.signedUrl);
    const oldUrl = new URL(signed.signedUrl);
    oldUrl.searchParams.set('api-version', '2012-02-12');
    const current = await request(currentUrl);
    const old = await request(oldUrl);
    Object.assign(report, {
      accepted: true,
      artifactId: String(finalized.artifactId),
      downloadSp: currentUrl.searchParams.get('sp'),
      rsct: currentUrl.searchParams.get('rsct'),
      currentStatus: current.status,
      currentTypeHex: rawHeaderHex(current, 'content-type'),
      oldStatus: old.status,
      oldTypeHex: rawHeaderHex(old, 'content-type'),
      bodyMatch: current.body.equals(payload) && old.body.equals(payload),
    });
  } catch (error) {
    report.accepted = false;
    report.error = String(error?.message || error).slice(0, 240);
  }
  console.log('BLOB-TYPE', JSON.stringify(report));
}
