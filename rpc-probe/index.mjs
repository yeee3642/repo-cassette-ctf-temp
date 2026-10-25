const token = process.env.ACTIONS_RUNTIME_TOKEN;
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('missing Actions.Results scope');
const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');

const endpoint = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact',
  process.env.ACTIONS_RESULTS_URL,
);
const base = {
  workflow_run_backend_id: workflowRunBackendId,
  workflow_job_run_backend_id: workflowJobRunBackendId,
  name: `missing-${process.env.GITHUB_RUN_ID}`,
  size: '1',
};
const fields = [
  ['baseline', null],
  ['mime_type', 'application/json\u0085'],
  ['content_type', 'application/json\u0085'],
  ['response_content_type', 'application/json\u0085'],
  ['media_type', 'application/json\u0085'],
  ['blob_content_type', 'application/json\u0085'],
  ['content_encoding', 'gzip'],
  ['version', 7],
  ['artifact_id', '1'],
  ['metadata', {mime_type: 'application/json\u0085'}],
  ['properties', {content_type: 'application/json\u0085'}],
  ['hash', 'sha256:' + '0'.repeat(64)],
];

for (const [label, value] of fields) {
  const document = label === 'baseline' ? base : {...base, [label]: value};
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(document),
  });
  const body = await response.text();
  console.log('RPC-PROBE', JSON.stringify({label, status: response.status,
    body: body.slice(0, 220)}));
}

async function artifactRpc(method, document) {
  const response = await fetch(new URL(
    `/twirp/github.actions.results.api.v1.ArtifactService/${method}`,
    process.env.ACTIONS_RESULTS_URL,
  ), {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify(document),
  });
  const body = await response.text();
  let data = {};
  try { data = JSON.parse(body); } catch { /* report status below */ }
  return {status: response.status, data, error: response.ok ? '' : body.slice(0, 160)};
}

const payload = Buffer.from('{"probe":"finalize-mime"}');
const candidates = [
  ['create-mime-type', 'create', 'mime_type'],
  ['create-content-type', 'create', 'content_type'],
  ['create-response-content-type', 'create', 'response_content_type'],
  ['create-media-type', 'create', 'media_type'],
  ['create-blob-content-type', 'create', 'blob_content_type'],
  ['finalize-mime-type', 'finalize', 'mime_type'],
  ['finalize-content-type', 'finalize', 'content_type'],
  ['finalize-response-content-type', 'finalize', 'response_content_type'],
  ['finalize-media-type', 'finalize', 'media_type'],
  ['finalize-blob-content-type', 'finalize', 'blob_content_type'],
];

for (const [label, phase, key] of candidates) {
  const name = `rpc-probe-${process.env.GITHUB_RUN_ID}-${label}.json`;
  const create = {
    workflow_run_backend_id: workflowRunBackendId,
    workflow_job_run_backend_id: workflowJobRunBackendId,
    name,
    version: 7,
    mime_type: 'application/json',
  };
  if (phase === 'create') create[key] = 'application/json\u0085';
  const created = await artifactRpc('CreateArtifact', create);
  if (created.status !== 200 || !created.data.signed_upload_url) {
    console.log('RPC-METADATA', JSON.stringify({label, phase, create: created.status,
      error: created.error}));
    continue;
  }

  const uploaded = await fetch(created.data.signed_upload_url, {
    method: 'PUT',
    headers: {'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json'},
    body: payload,
  });
  if (uploaded.status !== 201) {
    console.log('RPC-METADATA', JSON.stringify({label, phase, upload: uploaded.status}));
    continue;
  }
  const finalize = {
    workflow_run_backend_id: workflowRunBackendId,
    workflow_job_run_backend_id: workflowJobRunBackendId,
    name,
    size: String(payload.length),
  };
  if (phase === 'finalize') finalize[key] = 'application/json\u0085';
  const finalized = await artifactRpc('FinalizeArtifact', finalize);
  const artifactId = finalized.data.artifact_id;
  if (finalized.status !== 200 || !artifactId) {
    console.log('RPC-METADATA', JSON.stringify({label, phase, finalize: finalized.status,
      error: finalized.error}));
    continue;
  }
  let response;
  for (let attempt = 0; attempt < 8; attempt++) {
    response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
      {redirect: 'manual', headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'user-agent': 'repo-cassette-rpc-probe',
      }},
    );
    if (response.status !== 404) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const location = response.headers.get('location');
  const responseType = location ? new URL(location).searchParams.get('rsct') : null;
  console.log('RPC-METADATA', JSON.stringify({label, phase, artifactId: String(artifactId),
    status: response.status, rsctHex: responseType &&
      Buffer.from(responseType, 'latin1').toString('hex')}));
}
