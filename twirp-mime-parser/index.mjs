import {createHash} from 'node:crypto';
import https from 'node:https';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');
const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/',
  process.env.ACTIONS_RESULTS_URL);
const valid = 'application/json';
const nel = valid + String.fromCharCode(0x85);
const payload = Buffer.from('{"probe":"twirp-mime-parser"}');

async function rpcRaw(method, body) {
  const response = await fetch(new URL(method, service), {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body,
  });
  let data = {};
  try { data = await response.json(); } catch { /* status is still reported */ }
  return {status: response.status, data};
}

function finalResponse(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {accept: 'application/vnd.github.v3+json',
        'user-agent': 'twirp-mime-parser'},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        let typeHex = null;
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          if (response.rawHeaders[i].toLowerCase() === 'content-type') {
            typeHex = Buffer.from(response.rawHeaders[i + 1], 'latin1').toString('hex');
            break;
          }
        }
        resolve({status: response.statusCode, bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'), typeHex});
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('timeout')));
  });
}

const candidates = [
  ['wrapper-nel', base => JSON.stringify({...base, mime_type: {value: nel}})],
  ['duplicate-valid-then-nel', base =>
    `${JSON.stringify(base).slice(0, -1)},"mime_type":${JSON.stringify(valid)},` +
    `"mime_type":${JSON.stringify(nel)}}`],
  ['duplicate-nel-then-valid', base =>
    `${JSON.stringify(base).slice(0, -1)},"mime_type":${JSON.stringify(nel)},` +
    `"mime_type":${JSON.stringify(valid)}}`],
];

for (const [label, buildBody] of candidates) {
  const base = {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name: `twirp-mime-${process.env.GITHUB_RUN_ID}-${label}.json`,
    version: 7,
  };
  const report = {label};
  try {
    const created = await rpcRaw('CreateArtifact', buildBody(base));
    report.createStatus = created.status;
    if (created.status !== 200 || !created.data.signed_upload_url) {
      report.createCode = created.data.code ?? null;
      report.createMessage = String(created.data.msg ?? '').slice(0, 120);
      console.log('TWIRP-MIME', JSON.stringify(report));
      continue;
    }
    const upload = await fetch(created.data.signed_upload_url, {
      method: 'PUT',
      headers: {'x-ms-blob-type': 'BlockBlob', 'content-type': nel},
      body: payload,
    });
    report.uploadStatus = upload.status;
    if (upload.status !== 201) {
      console.log('TWIRP-MIME', JSON.stringify(report));
      continue;
    }
    const finalized = await rpcRaw('FinalizeArtifact', JSON.stringify({
      workflow_run_backend_id: runId,
      workflow_job_run_backend_id: jobId,
      name: base.name,
      size: String(payload.length),
    }));
    report.finalizeStatus = finalized.status;
    if (finalized.status !== 200 || !finalized.data.artifact_id) {
      console.log('TWIRP-MIME', JSON.stringify(report));
      continue;
    }
    report.artifactId = String(finalized.data.artifact_id);
    for (let retry = 0; retry < 8; retry++) {
      const api = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
        `/actions/artifacts/${report.artifactId}/zip`,
        {redirect: 'manual', headers: {accept: 'application/vnd.github.v3+json',
          authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'user-agent': 'twirp-mime-parser'}},
      );
      report.publicStatus = api.status;
      const location = api.headers.get('location');
      if (location) {
        const signed = new URL(location);
        const rsct = signed.searchParams.get('rsct');
        report.signedRsctHex = rsct === null ? null :
          Buffer.from(rsct, 'latin1').toString('hex');
        report.final = await finalResponse(signed);
        break;
      }
      if (api.status !== 404) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    report.localError = error?.name ?? 'Error';
  }
  console.log('TWIRP-MIME', JSON.stringify(report));
}
