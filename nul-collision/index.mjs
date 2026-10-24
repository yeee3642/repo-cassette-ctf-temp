import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const weird = 'application/json\u0085';
const exact = 'application/json';
const payload = Buffer.from('{}');
const digest = createHash('sha256').update(payload).digest('hex');
const stem = `nulcol-${process.env.GITHUB_RUN_ID}-`;

const pairs = [
  ['trail-nul', 'x', 'x\0'],
  ['lead-nul', 'x', '\0x'],
  ['middle-nul', 'xy', 'x\0y'],
  ['nul-tail-a', 'x', 'x\0a'],
  ['two-tails', 'x\0a', 'x\0b'],
  ['nul-space', 'x', 'x\0 '],
  ['nul-dot', 'x', 'x\0.'],
  ['nul-tab', 'x', 'x\0\t'],
  ['nul-nel', 'x', 'x\0\u0085'],
  ['double-nul', 'x\0', 'x\0\0'],
  ['ctrl-one', 'x', 'x\u0001'],
  ['ctrl-vt', 'x', 'x\u000b'],
  ['ctrl-ff', 'x', 'x\u000c'],
];

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
  await new BlobClient(url).getBlockBlobClient().uploadData(payload, {
    blobHTTPHeaders: {blobContentType: weird},
  });
}

async function finalize(name) {
  return client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(payload.length),
    hash: StringValue.create({value: `sha256:${digest}`}),
  });
}

async function inspect(id) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`,
    {redirect: 'manual', headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': 'repo-cassette-nul-collision',
    }},
  );
  const location = response.headers.get('location');
  if (!location) return {status: response.status};
  const target = new URL(location);
  return {
    status: response.status,
    extension: target.pathname.split('.').at(-1),
    rsctHex: Buffer.from(target.searchParams.get('rsct') || '', 'latin1').toString('hex'),
  };
}

for (let iteration = 0; iteration < 4; iteration++) {
  for (const [label, left, right] of pairs) {
    for (const reverse of [false, true]) {
      const suffix = `${iteration}-${label}-${reverse ? 1 : 0}`;
      const names = [stem + suffix + left, stem + suffix + right];
      const specs = reverse
        ? [[names[1], 7, exact], [names[0], 6, weird]]
        : [[names[0], 6, weird], [names[1], 7, exact]];
      const attempts = await Promise.allSettled(specs.map((args) => create(...args)));
      const row = {iteration, label, reverse, namesHex: names.map((x) => Buffer.from(x).toString('hex')),
        creates: [], finalizes: []};
      for (const attempt of attempts) {
        if (attempt.status === 'rejected') {
          row.creates.push({ok: false, error: String(attempt.reason).split(': ').at(-1).slice(0, 120)});
        } else {
          const url = attempt.value.signedUploadUrl;
          row.creates.push({ok: true, file: new URL(url).pathname.split('/').at(-1)});
          await upload(url);
        }
      }
      for (let index = 0; index < attempts.length; index++) {
        if (attempts[index].status !== 'fulfilled') continue;
        try {
          const done = await finalize(specs[index][0]);
          row.finalizes.push({ok: true, id: done.artifactId, download: await inspect(done.artifactId)});
        } catch (error) {
          row.finalizes.push({ok: false, error: String(error).split(': ').at(-1).slice(0, 120)});
        }
      }
      console.log('NUL-COLLISION', JSON.stringify(row));
    }
  }
}
