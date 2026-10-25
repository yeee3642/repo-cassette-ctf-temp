const token = process.env.ACTIONS_RUNTIME_TOKEN;
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');
const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/',
  process.env.ACTIONS_RESULTS_URL);
const name = `cassette-zip-mismatch-${process.env.GITHUB_RUN_ID}.zip`;
const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name};
const body = Buffer.from('{"probe":"zip-name-mime-branch"}');

async function rpc(method, fields) {
  const response = await fetch(new URL(method, service), {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify(fields),
  });
  if (!response.ok) throw new Error(`${method} status ${response.status}`);
  return response.json();
}

const created = await rpc('CreateArtifact', {
  ...ids, version: 7, mime_type: 'application/json',
});
const upload = await fetch(created.signed_upload_url, {
  method: 'PUT',
  headers: {'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json'},
  body,
});
if (upload.status !== 201) throw new Error(`upload status ${upload.status}`);
const finalized = await rpc('FinalizeArtifact', {...ids, size: String(body.length)});
const artifactId = String(finalized.artifact_id);

for (let attempt = 0; attempt < 8; attempt++) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
    `/actions/artifacts/${artifactId}/zip`,
    {redirect: 'manual', headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': 'repo-cassette-zip-mismatch-probe',
    }},
  );
  if (response.status === 404 && attempt < 7) {
    await new Promise(resolve => setTimeout(resolve, 500));
    continue;
  }
  const location = response.headers.get('location');
  const target = location ? new URL(location) : null;
  console.log('ZIP-MISMATCH', JSON.stringify({
    status: response.status,
    artifactId,
    rsct: target?.searchParams.get('rsct') ?? null,
    hasApiVersion: target?.searchParams.has('api-version') ?? false,
  }));
  if (response.status !== 302 || !target) throw new Error('No artifact redirect');
  break;
}
