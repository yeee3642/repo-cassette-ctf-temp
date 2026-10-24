import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const payload = Buffer.from('{"probe":"legacy-valid-mime"}');
const digest = createHash('sha256').update(payload).digest('hex');

for (let version = 0; version <= 7; version++) {
  const name = `legacy-valid-v${version}-${process.env.GITHUB_RUN_ID}.json`;
  const report = {version};
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
      blobHTTPHeaders: {blobContentType: 'application/json'},
    });
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(payload.length),
      hash: StringValue.create({value: `sha256:${digest}`}),
    });
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      {redirect: 'manual', headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'user-agent': 'legacy-mime-probe',
      }},
    );
    const location = response.headers.get('location');
    const target = location ? new URL(location) : null;
    Object.assign(report, {
      artifactId: String(finalized.artifactId),
      status: response.status,
      suffix: target?.pathname.split('/').at(-1).split('.').at(-1) ?? null,
      rsct: target?.searchParams.get('rsct') ?? null,
      rscd: target?.searchParams.get('rscd') ?? null,
    });
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 220);
  }
  console.log('LEGACY-MIME', JSON.stringify(report));
}
