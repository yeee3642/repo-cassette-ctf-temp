import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"v6-name-edge"}');
const digest = createHash('sha256').update(body).digest('hex');
const stamp = process.env.GITHUB_RUN_ID;
const cases = [
  ['crlf', `v6-${stamp}-a\r\nContent-Type: application/json\u0085.json`],
  ['lf', `v6-${stamp}-b\nContent-Type: application/json\u0085.json`],
  ['cr', `v6-${stamp}-c\rContent-Type: application/json\u0085.json`],
  ['nul-crlf', `v6-${stamp}-d\0\r\nContent-Type: application/json\u0085.json`],
  ['amp', `v6-${stamp}-e&api-version=2012-02-12.json`],
  ['question', `v6-${stamp}-f?api-version=2012-02-12.json`],
  ['nel', `v6-${stamp}-g\u0085.json`],
  ['encoded', `v6-${stamp}-h%0d%0aContent-Type%3Aapplication%2Fjson%85.json`],
];

for (const [label, name] of cases) {
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 6,
      mimeType: StringValue.create({value: '\u0085application/json'}),
    });
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: '\u0085application/json'},
    });
    const result = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(body.length),
      hash: StringValue.create({value: `sha256:${digest}`}),
    });
    console.log('V6NAME', JSON.stringify({label, ok: result.ok,
      id: String(result.artifactId), nameHex: Buffer.from(name).toString('hex')}));
  } catch (error) {
    console.log('V6NAME', JSON.stringify({label, error: String(error?.message || error).slice(0, 220)}));
  }
}
