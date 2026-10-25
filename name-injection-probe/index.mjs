import {createHash} from 'node:crypto';
import https from 'node:https';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const payload = Buffer.from('{"probe":"artifact-name-header"}');
const digest = createHash('sha256').update(payload).digest('hex');
const namePrefix = `name-header-${process.env.GITHUB_RUN_ID}-`;

const cases = [
  ['crlf-header', 'a\r\nContent-Type: application/json\u0085'],
  ['lf-header', 'b\nContent-Type: application/json\u0085'],
  ['cr-header', 'c\rContent-Type: application/json\u0085'],
  ['percent-crlf', 'd%0D%0AContent-Type:%20application/json%85'],
  ['quote-semicolon', 'e"; api-version=2012-02-12; filename="x'],
];

function getFinal(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function check(label, suffix) {
  const name = namePrefix + suffix;
  const result = {label};
  let created;
  try {
    created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    result.create = 'ok';
  } catch (error) {
    result.create = 'failed';
    result.errorName = error.name;
    result.errorStatus = error.statusCode ?? error.status ?? null;
    return result;
  }

  try {
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
      blobHTTPHeaders: {blobContentType: 'application/json\u0085'},
    });
    const finished = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(payload.length),
      hash: StringValue.create({value: `sha256:${digest}`}),
    });
    result.artifactId = String(finished.artifactId);
  } catch (error) {
    result.finalize = 'failed';
    result.errorName = error.name;
    result.errorStatus = error.statusCode ?? error.status ?? null;
    return result;
  }

  const apiUrl = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
    `/actions/artifacts/${result.artifactId}/zip`;
  const api = await fetch(apiUrl, {redirect: 'manual', headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-name-header-check',
  }});
  result.apiStatus = api.status;
  const location = api.headers.get('location');
  if (!location) return result;
  const target = new URL(location);
  result.rsctHex = Buffer.from(target.searchParams.get('rsct') || '', 'latin1').toString('hex');
  result.hasApiVersion = target.searchParams.has('api-version');
  result.rscdLength = (target.searchParams.get('rscd') || '').length;
  try {
    const final = await getFinal(location);
    result.finalStatus = final.status;
    result.finalBodySha256 = createHash('sha256').update(final.body).digest('hex');
    result.contentTypeHex = Buffer.from(final.headers['content-type'] || '', 'latin1').toString('hex');
    result.contentTypeRawHex = [];
    for (let i = 0; i + 1 < final.rawHeaders.length; i += 2) {
      if (final.rawHeaders[i].toLowerCase() === 'content-type') {
        result.contentTypeRawHex.push(Buffer.from(final.rawHeaders[i + 1], 'latin1').toString('hex'));
      }
    }
  } catch (error) {
    result.finalRead = 'failed';
    result.errorName = error.name;
    result.errorCode = error.code ?? null;
  }
  return result;
}

for (const [label, suffix] of cases) {
  console.log('NAME-HEADER', JSON.stringify(await check(label, suffix)));
}
