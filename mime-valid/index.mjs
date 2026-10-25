const token = process.env.ACTIONS_RUNTIME_TOKEN;
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');
const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/',
  process.env.ACTIONS_RESULTS_URL);
const payload = Buffer.from('{"probe":"valid-mime-override"}');

async function rpc(method, body) {
  const response = await fetch(new URL(method, service), {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* report status */ }
  return {status: response.status, data, error: response.ok ? '' : text.slice(0, 120)};
}

const types = ['application/json'];
for (let index = 0; index < types.length; index++) {
  const mime = types[index];
  const name = `mime-valid-${process.env.GITHUB_RUN_ID}-${index}.json`;
  const base = {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name,
  };
  const created = await rpc('CreateArtifact', {
    ...base, version: 7,
  });
  const report = {declaration: 'omitted-mime-v7', mime, create: created.status, error: created.error};
  if (created.status === 200 && created.data.signed_upload_url) {
    const uploaded = await fetch(created.data.signed_upload_url, {
      method: 'PUT',
      headers: {'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json'},
      body: payload,
    });
    report.upload = uploaded.status;
    if (uploaded.status === 201) {
      const finalized = await rpc('FinalizeArtifact', {
        ...base, size: String(payload.length),
      });
      report.finalize = finalized.status;
      if (finalized.status === 200 && finalized.data.artifact_id) {
        report.artifactId = String(finalized.data.artifact_id);
        for (let retry = 0; retry < 8; retry++) {
          const response = await fetch(
            `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
            `/actions/artifacts/${report.artifactId}/zip`,
            {redirect: 'manual', headers: {
              accept: 'application/vnd.github.v3+json',
              authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
              'user-agent': 'repo-cassette-valid-mime-probe',
            }},
          );
          report.publicStatus = response.status;
          const location = response.headers.get('location');
          if (location) {
            const url = new URL(location);
            report.rsct = url.searchParams.get('rsct');
            report.apiVersion = url.searchParams.get('api-version');
            break;
          }
          if (response.status !== 404) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
  }
  console.log('VALID-MIME', JSON.stringify(report));
}
