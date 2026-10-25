import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const nel = 'application/json\u0085';
const data = Buffer.from('{}');
const hash = 'sha256:' + createHash('sha256').update(data).digest('hex');
const headers = {
  accept: 'application/vnd.github.v3+json',
  authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
  'user-agent': 'repo-cassette-postfinal-probe',
};

async function create(name, version, mime) {
  return client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: mime}),
  });
}

async function upload(signedUploadUrl) {
  await new BlobClient(signedUploadUrl).getBlockBlobClient().uploadData(data, {
    blobHTTPHeaders: {blobContentType: nel},
  });
}

async function finalize(name) {
  return client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(data.length),
    hash: StringValue.create({value: hash}),
  });
}

async function inspect(id, phase) {
  const response = await fetch(
    'https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY +
      '/actions/artifacts/' + id + '/zip',
    {headers, redirect: 'manual'},
  );
  const location = response.headers.get('location');
  if (!location) return {phase, status: response.status};
  const signed = new URL(location);
  const final = await fetch(location);
  const body = Buffer.from(await final.arrayBuffer());
  return {
    phase,
    status: response.status,
    rsct: signed.searchParams.get('rsct') || 'absent',
    finalStatus: final.status,
    mimeHex: Buffer.from(final.headers.get('content-type') || '', 'latin1').toString('hex'),
    bodyHash: createHash('sha256').update(body).digest('hex'),
  };
}

const cases = [];
for (const [label, firstVersion, firstMime, secondVersion, secondMime] of cases) {
  const name = 'cassette-postfinal-' + label + '-' + process.env.GITHUB_RUN_ID;
  const result = {label};
  const first = await create(name, firstVersion, firstMime);
  if (!first.ok) throw new Error('first CreateArtifact failed');
  await upload(first.signedUploadUrl);
  const finalized = await finalize(name);
  if (!finalized.ok) throw new Error('first FinalizeArtifact failed');
  result.firstId = String(finalized.artifactId);
  result.before = await inspect(result.firstId, 'before');
  try {
    const second = await create(name, secondVersion, secondMime);
    result.secondCreate = {ok: second.ok,
      sameBlob: second.signedUploadUrl === first.signedUploadUrl};
    if (second.ok) {
      await upload(second.signedUploadUrl);
      result.afterCreate = await inspect(result.firstId, 'afterCreate');
      try {
        const secondFinal = await finalize(name);
        result.secondId = String(secondFinal.artifactId);
        result.afterSecondFinal = await inspect(result.firstId, 'afterSecondFinal');
        if (result.secondId !== result.firstId) {
          result.secondDownload = await inspect(result.secondId, 'secondId');
        }
      } catch (error) {
        result.secondFinalError = String(error).slice(0, 140);
      }
    }
  } catch (error) {
    result.secondCreateError = String(error).slice(0, 140);
  }
  console.log('POSTFINAL-RESULT', JSON.stringify(result));
}

for (const [label, mime] of [
  ['nel-after-nul', 'application/json\u0000\u0085'],
]) {
  const name = 'cassette-mime-' + label + '-' + process.env.GITHUB_RUN_ID;
  const result = {label};
  try {
    const created = await create(name, 7, mime);
    result.create = {ok: created.ok};
    if (created.ok) {
      await upload(created.signedUploadUrl);
      const finalized = await finalize(name);
      result.id = String(finalized.artifactId);
      result.download = await inspect(result.id, 'delimiter-mime');
    }
  } catch (error) {
    result.createError = String(error).slice(0, 140);
  }
  console.log('MIME-DELIMITER-RESULT', JSON.stringify(result));
}
