import https from 'node:https';
import {createHash} from 'node:crypto';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const nelType = 'application/json\u0085';
const payload = Buffer.from('{}');
const digest = createHash('sha256').update(payload).digest('hex');
const stamp = process.env.GITHUB_RUN_ID;

const candidates = [
  ['lead-nel', '\u0085application/json'],
  ['lead-fs', '\u001capplication/json'],
  ['lead-gs', '\u001dapplication/json'],
  ['lead-rs', '\u001eapplication/json'],
  ['lead-us', '\u001fapplication/json'],
  ['lead-vt', '\u000bapplication/json'],
  ['lead-ff', '\u000capplication/json'],
  ['lead-nbsp-nel', '\u00a0\u0085application/json'],
  ['wild-all', '*/*'],
  ['wild-app', 'application/*'],
  ['wild-sub', '*/json'],
  ['pct85', 'application/json%85'],
  ['pct-c285', 'application/json%C2%85'],
  ['pct-u85', 'application/json%u0085'],
  ['pct-pct85', 'application/json%2585'],
  ['amp', 'application/json&x=y'],
  ['hash', 'application/json#x'],
  ['apostrophe', "application/json'x"],
  ['bang', 'application/json!x'],
  ['dollar', 'application/json$x'],
  ['caret', 'application/json^x'],
  ['backtick', 'application/json`x'],
  ['pipe', 'application/json|x'],
  ['tilde', 'application/json~x'],
  ['brace', 'application/json{x}'],
  ['lead-space', ' application/json'],
  ['trail-space', 'application/json '],
  ['lead-tab', '\tapplication/json'],
  ['trail-tab', 'application/json\t'],
  ['trail-vt', 'application/json\u000b'],
  ['trail-ff', 'application/json\u000c'],
  ['trail-fs', 'application/json\u001c'],
  ['trail-gs', 'application/json\u001d'],
  ['trail-rs', 'application/json\u001e'],
  ['trail-us', 'application/json\u001f'],
  ['semi', 'application/json;'],
  ['param-empty', 'application/json;x='],
  ['param-token', 'application/json;x=y'],
  ['param-quote', 'application/json;x="y"'],
  ['param-space', 'application/json; x = y'],
  ['param-star', "application/json;x*=UTF-8''abc"],
  ['param-pct85', 'application/json;x=%85'],
  ['param-q-pct85', 'application/json;x="%85"'],
  ['param-dupe', 'application/json;x=y;x=z'],
  ['comment', 'application/json (x)'],
  ['upper', 'APPLICATION/JSON'],
  ['double-slash', 'application//json'],
  ['space-slash', 'application / json'],
  ['empty', ''],
  ['long-subtype', `application/${'a'.repeat(1024)}`],
  ['long-param', `application/json;x=${'a'.repeat(1800)}`],
];

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
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

for (let index = 0; index < candidates.length; index++) {
  const [label, mime] = candidates[index];
  const name = `mime-matrix-${stamp}-${index}`;
  const report = {label, inputHex: Buffer.from(mime, 'utf8').toString('hex')};
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: mime}),
    });
    const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(payload, {blobHTTPHeaders: {blobContentType: nelType}});
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(payload.length),
      hash: StringValue.create({value: `sha256:${digest}`}),
    });
    const direct = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const internal = new URL(direct.signedUrl);
    const first = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      {headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'user-agent': 'mime-matrix',
      }},
    );
    const location = first.headers.location ? new URL(first.headers.location) : null;
    const final = location ? await request(location) : null;
    Object.assign(report, {
      accepted: true,
      artifactId: String(finalized.artifactId),
      internalRsct: internal.searchParams.get('rsct'),
      publicStatus: first.status,
      publicRsct: location?.searchParams.get('rsct') ?? null,
      finalStatus: final?.status ?? null,
      finalTypeHex: final ? rawHeaderHex(final, 'content-type') : null,
    });
  } catch (error) {
    report.accepted = false;
    report.error = String(error?.message || error).slice(0, 180);
  }
  console.log('MIME-MATRIX', JSON.stringify(report));
}
