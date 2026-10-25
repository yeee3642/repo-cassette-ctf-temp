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
