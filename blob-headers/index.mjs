import https from 'node:https';
import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"blob-header"}');
const sha = createHash('sha256').update(body).digest('hex');
const cases = [
  ['baseline', {}],
  ['disposition-nel', {blobContentDisposition: 'attachment\u0085Content-Type: application/json\u0085'}],
  ['disposition-crlf', {blobContentDisposition: 'attachment\r\nContent-Type: application/json\u0085'}],
  ['disposition-percent', {blobContentDisposition: 'attachment%0D%0AContent-Type: application/json%85'}],
  ['disposition-vt', {blobContentDisposition: 'attachment\u000bContent-Type: application/json\u0085'}],
  ['language-nel', {blobContentLanguage: 'en\u0085Content-Type: application/json\u0085'}],
  ['cache-nel', {blobCacheControl: 'public\u0085Content-Type: application/json\u0085'}],
  ['encoding-nel', {blobContentEncoding: 'identity\u0085Content-Type: application/json\u0085'}],
];

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode,
        headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

for (const [label, extra] of cases) {
  const report = {label};
  const name = `blob-headers-${process.env.GITHUB_RUN_ID}-${label}`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, version: 7,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: 'application/json\u0085', ...extra},
    });
    const done = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, size: String(body.length),
      hash: StringValue.create({value: `sha256:${sha}`}),
    });
    report.artifactId = String(done.artifactId);
    const api = await fetchRaw(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
      `/actions/artifacts/${report.artifactId}/zip`, {
        accept: 'application/vnd.github.v3+json',
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'user-agent': 'repo-cassette-blob-header-probe',
      });
    report.apiStatus = api.status;
    if (api.headers.location) {
      const signed = new URL(api.headers.location);
      report.rsct = signed.searchParams.get('rsct');
      const final = await fetchRaw(signed);
      report.finalStatus = final.status;
      report.contentTypesHex = [];
      for (let i = 0; i < final.rawHeaders.length; i += 2) {
        if (final.rawHeaders[i].toLowerCase() === 'content-type') {
          report.contentTypesHex.push(Buffer.from(final.rawHeaders[i + 1], 'latin1').toString('hex'));
        }
      }
    }
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 160);
  }
  console.log('BLOB-HEADERS', JSON.stringify(report));
}
