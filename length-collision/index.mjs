import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = 'application/json\u0085';
const body = Buffer.from('{}');
const digest = createHash('sha256').update(body).digest('hex');
const stamp = process.env.GITHUB_RUN_ID;

async function create(name, version, mime) {
  return client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: mime}),
  });
}

async function upload(url) {
  await new BlobClient(url).getBlockBlobClient().uploadData(body, {
    blobHTTPHeaders: {blobContentType: odd},
  });
}

async function finalize(name) {
  return client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(body.length),
    hash: StringValue.create({value: `sha256:${digest}`}),
  });
}

async function inspect(id) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`,
    {redirect: 'manual', headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': 'repo-cassette-length-collision',
    }},
  );
  const location = response.headers.get('location');
  if (!location) return {status: response.status};
  const target = new URL(location);
  return {
    status: response.status,
    extension: target.pathname.includes('.') ? target.pathname.split('.').at(-1) : '',
    rsct: target.searchParams.get('rsct'),
  };
}

const lengths = [31, 32, 63, 64, 127, 128, 191, 192, 239, 240, 247, 248,
  249, 250, 251, 252, 253, 254, 255, 256, 257, 260, 511, 512, 1023];

for (const length of lengths) {
  for (const reverse of [false, true]) {
    const tag = `lc-${stamp}-${length}-${reverse ? 1 : 0}-`;
    const prefix = tag + 'x'.repeat(Math.max(0, length - tag.length - 1));
    const names = [prefix + 'A', prefix + 'B'];
    const specs = reverse
      ? [[names[1], 7, 'application/json'], [names[0], 6, odd]]
      : [[names[0], 6, odd], [names[1], 7, 'application/json']];
    const attempts = await Promise.allSettled(specs.map(args => create(...args)));
    const row = {length, reverse, actual: names.map(name => Buffer.byteLength(name)),
      creates: [], finalizes: []};
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') {
        row.creates.push({ok: false, error: String(attempt.reason).split(': ').at(-1).slice(0, 140)});
      } else {
        const url = attempt.value.signedUploadUrl;
        row.creates.push({ok: true, blob: new URL(url).pathname.split('/').at(-1)});
        await upload(url);
      }
    }
    for (let index = 0; index < attempts.length; index++) {
      if (attempts[index].status !== 'fulfilled') continue;
      try {
        const done = await finalize(specs[index][0]);
        row.finalizes.push({ok: true, id: done.artifactId,
          download: await inspect(done.artifactId)});
      } catch (error) {
        row.finalizes.push({ok: false, error: String(error).split(': ').at(-1).slice(0, 140)});
      }
    }
    console.log('LENGTH-COLLISION', JSON.stringify(row));
  }
}
