import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The adaptation is local to reviewed upload modules, never a global XHR/fetch patch.
export const ADMIN_CONTRACTS: Record<string, string> = {
  'hooks/useUpload.mjs': '0ee504ba1dbe389bcbb6b3914ff93a708f0db73647268b41dd1a9bad0aca5015',
  'hooks/useEditAsset.mjs': '22e35190ac80fb85d7434ff4bc63a93555aa882f68803529614cdbd4060aa7fe',
  'hooks/useRemoveAsset.mjs': '74fa46a8d25ea539b57c160362ea24d3fc803fe4de4a45d162cb482d3c293895',
  'future/services/uploadFileViaXHR.mjs': '78e07a41fa5b705390b292b1167ee58b148b297a3b58daafc9af130ed54a9e89',
  'future/services/api.mjs': '2b09460f1af969192e83a0916edcbe1829b2af09f102274ed9d8909d961006f7',
  'future/services/assets.mjs': '4b7dd048d9b6da094b97da6e0b38dabf93218150b33393d5180557c660e1d6bb',
};
function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('Strapi upload adaptation requires exactly one reviewed call site');
  return source.replace(before, after);
}
export function adaptAdminUpload(source: string, name: string) {
  const expected = ADMIN_CONTRACTS[name];
  if (!expected) return source;
  if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error(`Unreviewed Strapi upload module: ${name}`);
  let code = source;
  const once = (before: string, after: string) => { code = replaceOnce(code, before, after); };
  if (name === 'hooks/useUpload.mjs') {
    once('const abortController = new AbortController();', 'const abortController = React.useRef(new AbortController()).current;');
    once('return uploadFileViaXHR(`${window.strapi.backendURL}${endpoint}`, token, formData, signal, (loaded, total)=>{',
      'return runMediaIntent({ url: `${window.strapi.backendURL}${endpoint}`, formData, signal, shape: "array" }, (key) => uploadFileViaXHR(`${window.strapi.backendURL}${endpoint}`, token, formData, signal, (loaded, total)=>{');
    once('    });\n};\nconst useUpload', '    }, key));\n};\nconst useUpload');
  } else if (name === 'hooks/useEditAsset.mjs') {
    once('const abortController = new AbortController();', 'const abortController = React.useRef(new AbortController()).current;');
    once('return post(endpoint, formData, {\n        signal\n    }).then((res)=>res.data);',
      'return file ? runMediaIntent({ url: `${window.strapi.backendURL}${endpoint}`, formData, signal, shape: "single" }, (key) => post(endpoint, formData, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { "Idempotency-Key": key } }).then((res)=>res.data)) : post(endpoint, formData, { signal }).then((res)=>res.data);');
  } else if (name === 'hooks/useRemoveAsset.mjs') {
    once('(assetId)=>del(`/upload/files/${assetId}`)', '(assetId)=>runMediaIntent({ url: `${window.strapi.backendURL}/upload/files/${assetId}`, method: "DELETE", shape: "single" }, (key) => del(`/upload/files/${assetId}`, { headers: { "Idempotency-Key": key }, signal: AbortSignal.timeout(30000) }).then((response) => response.data))');
  } else if (name === 'future/services/uploadFileViaXHR.mjs') {
    once('const sendUploadViaXHR = (url, token, formData, signal, onProgress)=>{', 'const sendUploadViaXHR = (url, token, formData, signal, onProgress, idempotencyKey)=>{');
    once('const uploadFileViaXHR = async (url, token, formData, signal, onProgress)=>{', 'const uploadFileViaXHR = async (url, token, formData, signal, onProgress, idempotencyKey)=>{');
    once("xhr.open('POST', url);", "xhr.open('POST', url);\n        if (idempotencyKey) xhr.setRequestHeader('Idempotency-Key', idempotencyKey);\n        xhr.timeout = 30000;");
    once('let isServerMessage = false;', 'let isServerMessage = false;\n            let recoveryCode;');
    once('const parsed = JSON.parse(xhr.responseText);', 'const parsed = JSON.parse(xhr.responseText);\n                recoveryCode = parsed?.error?.name;');
    once('reject(new UploadFileError(message, xhr.status, isServerMessage));', 'reject(Object.assign(new UploadFileError(message, xhr.status, isServerMessage), { code: recoveryCode }));');
    once('xhr.onerror = ()=>{', 'xhr.ontimeout = ()=>{ cleanup(); reject(new UploadFileError("Upload response timed out")); };\n        xhr.onerror = ()=>{');
    once('sendUploadViaXHR(url, token, formData, signal, onProgress)', 'sendUploadViaXHR(url, token, formData, signal, onProgress, idempotencyKey)');
    once('sendUploadViaXHR(url, refreshedToken, formData, signal, onProgress)', 'sendUploadViaXHR(url, refreshedToken, formData, signal, onProgress, idempotencyKey)');
    return code;
  } else if (name === 'future/services/api.mjs') {
    once('const entries = files.map((file, index)=>({\n                            file,', 'const entries = files.map((file, index)=>({\n                            operationKey: crypto.randomUUID(),\n                            file,');
    once('await uploadFileViaXHR(url, token, formData, abortController.signal, (bytes)=>batcher.schedule(bytes))',
      'await runMediaIntent({ url, formData, signal: abortController.signal, shape: "single", key: entry.operationKey }, (key) => uploadFileViaXHR(url, token, formData, abortController.signal, (bytes)=>batcher.schedule(bytes), key))');
    once('await uploadFileViaXHR(url, token, formData, new AbortController().signal, ()=>{})',
      'await runMediaIntent({ url, formData, shape: "single" }, (key) => uploadFileViaXHR(url, token, formData, new AbortController().signal, ()=>{}, key))');
  } else if (name === 'future/services/assets.mjs') {
    once("query: (id)=>({\n                        url: `/upload/files/${id}`,\n                        method: 'DELETE'\n                    }),", `queryFn: async (id) => {
                    try {
                        const data = await runMediaIntent({ url: window.strapi.backendURL + '/upload/files/' + id, method: 'DELETE', shape: 'single' }, (key) => getFetchClient().del('/upload/files/' + id, { headers: { 'Idempotency-Key': key }, signal: AbortSignal.timeout(30000) }).then((response) => response.data));
                        return { data };
                    } catch (error) { return { error: { name: error.name, message: error.message } }; }
                },`);
    code = "import { getFetchClient } from '@strapi/admin/strapi-admin';\n" + code;
  }
  return "import { runMediaIntent } from '@gthf/media-recovery';\n" + code;
}
export function adminRecoveryPlugin(root: string) {
  const packageRoot = path.dirname(require.resolve('@strapi/upload/package.json'));
  const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageInfo.version !== '5.52.3') throw new Error('Review the media adapter before changing Strapi upload version');
  // Validate every module, including the inactive beta UI, before starting a build.
  for (const name of Object.keys(ADMIN_CONTRACTS)) adaptAdminUpload(fs.readFileSync(path.join(packageRoot, 'dist/admin', name), 'utf8'), name);
  return { name: 'gthf-media-recovery', enforce: 'pre' as const,
    transform(source: string, id: string) {
      const file = id.split('?')[0];
      const marker = '/@strapi/upload/dist/admin/';
      const index = file.lastIndexOf(marker);
      if (index < 0) return null;
      const name = file.slice(index + marker.length);
      return ADMIN_CONTRACTS[name] ? { code: adaptAdminUpload(source, name), map: null } : null;
    },
  };
}
