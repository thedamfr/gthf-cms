import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Adapt reviewed Strapi modules at build time, never the browser-global XHR/fetch.
export const ADMIN_CONTRACTS: Record<string, string> = {
  'hooks/useUpload.mjs': '0ee504ba1dbe389bcbb6b3914ff93a708f0db73647268b41dd1a9bad0aca5015',
  'hooks/useEditAsset.mjs': '22e35190ac80fb85d7434ff4bc63a93555aa882f68803529614cdbd4060aa7fe',
  'hooks/useBulkRemove.mjs': '19d73cf3a3c1654781b71c25a2d813e2476931916978b38afb4e2dfd15be8469',
  'components/EditFolderDialog/EditFolderDialog.mjs': 'cecedd231e6d91cf87f9d8d617735270966bcd4c2956c74c371be0fb6d3a3cb0',
  'future/pages/Assets/components/DeleteItemsDialog.mjs': 'bfd7fca4e30f339ff593e86dc056ae6fecd6bb70169b336faa7e3af3def59c68',
  'hooks/useRemoveAsset.mjs': '74fa46a8d25ea539b57c160362ea24d3fc803fe4de4a45d162cb482d3c293895',
  'future/services/uploadFileViaXHR.mjs': '78e07a41fa5b705390b292b1167ee58b148b297a3b58daafc9af130ed54a9e89',
  'future/services/api.mjs': '2b09460f1af969192e83a0916edcbe1829b2af09f102274ed9d8909d961006f7',
  'future/services/assets.mjs': '4b7dd048d9b6da094b97da6e0b38dabf93218150b33393d5180557c660e1d6bb',
};
export const ADMIN_FETCH_CONTRACTS: Record<string, string> = {
  'admin/src/utils/getFetchClient.mjs': 'ad3b569e34d55260760eafabb278953479e3b5e56ba720693ab4cf9c17f6a8f4',
};
function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('Strapi upload adaptation requires exactly one reviewed call site');
  return source.replace(before, after);
}
export function adaptAdminFetchClient(source: string, name: string) {
  const expected = ADMIN_FETCH_CONTRACTS[name];
  if (!expected) return source;
  if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error(`Unreviewed Strapi admin module: ${name}`);
  // Strapi 5.52.3 POST drops responseType, unlike GET. Keep the existing
  // interceptor, JSON default and withTokenRefresh; only forward this option.
  const before = `return responseInterceptor(response, options?.validateStatus);
            };
            return withTokenRefresh(url, executeRequest);
        },
        put: async (url, data, options)=>{`;
  return replaceOnce(source, before, before.replace(
    'responseInterceptor(response, options?.validateStatus)',
    'responseInterceptor(response, options?.validateStatus, options?.responseType)',
  ));
}
export function adaptAdminUpload(source: string, name: string) {
  const expected = ADMIN_CONTRACTS[name];
  if (!expected) return source;
  if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error(`Unreviewed Strapi upload module: ${name}`);
  let code = source;
  const once = (before: string, after: string) => { code = replaceOnce(code, before, after); };
  if (name === 'hooks/useUpload.mjs') {
    once('const abortController = new AbortController();', 'const abortController = React.useRef(null);');
    once('const signal = abortController.signal;', '');
    once('const cancel = ()=>abortController.abort();', 'const cancel = ()=>abortController.current?.abort();');
    once('return uploadAssets(assets, folderId, signal, setProgress, store.getState().admin_app?.token);', 'abortController.current = new AbortController(); return uploadAssets(assets, folderId, abortController.current.signal, setProgress, store.getState().admin_app?.token);');
    once('return uploadFileViaXHR(`${window.strapi.backendURL}${endpoint}`, token, formData, signal, (loaded, total)=>{',
      'return runMediaIntent({ url: `${window.strapi.backendURL}${endpoint}`, formData, signal, shape: "array" }, (key) => uploadFileViaXHR(`${window.strapi.backendURL}${endpoint}`, token, formData, signal, (loaded, total)=>{');
    once('    });\n};\nconst useUpload', '    }, key));\n};\nconst useUpload');
  } else if (name === 'hooks/useEditAsset.mjs') {
    once('const abortController = new AbortController();', 'const abortController = React.useRef(null);');
    once('const signal = abortController.signal;', '');
    once('const cancel = ()=>abortController.abort();', 'const cancel = ()=>abortController.current?.abort();');
    once('({ asset, file })=>editAssetRequest(asset, file, signal, setProgress, post)', '({ asset, file })=>{ abortController.current = new AbortController(); return editAssetRequest(asset, file, abortController.current.signal, setProgress, post); }');
    once('return post(endpoint, formData, {\n        signal\n    }).then((res)=>res.data);',
      'return file ? runMediaIntent({ url: `${window.strapi.backendURL}${endpoint}`, formData, signal, shape: "single" }, (key) => post(endpoint, formData, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { "Idempotency-Key": key } }).then((res)=>res.data)) : post(endpoint, formData, { signal }).then((res)=>res.data);');
  } else if (name === 'hooks/useBulkRemove.mjs') {
    once("return post('/upload/actions/bulk-delete', payload);", `return runBulkDeleteIntent({ payload, key: bulkSelectionKey(filesAndFolders) }, (key, frozenPayload) => post('/upload/actions/bulk-delete', frozenPayload, { headers: { 'Idempotency-Key': key }, signal: AbortSignal.timeout(30000) }).then((response) => response.data.data)).then((result) => ({ data: { data: result } }));`);
  } else if (name === 'components/EditFolderDialog/EditFolderDialog.mjs') {
    once('const { remove } = useBulkRemove();', 'const { remove } = useBulkRemove();\n    const recoverySelection = React.useMemo(() => folder ? [folder] : [], [folder?.id]);');
    once('await remove([\n                folder\n            ]);', 'await remove(recoverySelection);');
  } else if (name === 'future/pages/Assets/components/DeleteItemsDialog.mjs') {
    code = "import { useRef } from 'react';\n" + code;
    once('const count = target.fileIds.length + target.folderIds.length;', `const count = target.fileIds.length + target.folderIds.length;
    const recoverySelection = useRef(null);
    const signature = JSON.stringify({ fileIds: [...target.fileIds].sort((a, b) => a-b), folderIds: [...target.folderIds].sort((a, b) => a-b) });
    if (!open) recoverySelection.current = null;
    else if (!recoverySelection.current || recoverySelection.current.signature !== signature) recoverySelection.current = { signature, token: {} };`);
    once('const res = await bulkDeleteItems(target);', 'const res = await bulkDeleteItems({ ...target, operationKey: bulkSelectionKey(recoverySelection.current.token) });');
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
    once('const fetchUrlUploadStream = async ({ token, urls, folderId, signal })=>{',
      'const fetchUrlUploadStream = async ({ token, urls, folderId, signal, operationKeys })=>{');
    once('            urls,\n            folderId\n        }),', '            urls,\n            folderId,\n            operationKeys\n        }),');
    once('const processSSEStream = async ({ response, dispatch, uploadId, generateAiMetadata, folderId })=>{',
      'const processSSEStream = async ({ response, dispatch, uploadId, generateAiMetadata, folderId, recoveryIntents })=>{');
    once('            const parsed = JSON.parse(data);\n            const index = parsed.index;',
      '            const parsed = JSON.parse(data);\n            observeUrlUploadEvent(recoveryIntents, event, parsed);\n            const index = parsed.index;');
    once('                            file: payload.file,\n                            index,\n                            uploadId,\n                            enabled: generateAiMetadata,',
      '                            file: payload.file,\n                            index,\n                            uploadId,\n                            enabled: generateAiMetadata && !payload.replayed,');
    once('    return streamResult;\n};', '    return requireUrlStreamCompletion(streamResult, recoveryIntents);\n};');
    once('                    try {\n                        // Send URLs to server for fetching and uploading',
      '                    try {\n                        const recoveryIntents = await prepareUrlUploadIntents({ urls, folderId });\n                        // Send URLs to server for fetching and uploading');
    once('                        const response = await fetchUrlUploadStream({\n                            token,\n                            urls,\n                            folderId,',
      '                        const response = await fetchUrlUploadStream({\n                            token,\n                            urls: recoveryIntents.map((intent) => intent.sourceUrl),\n                            folderId,\n                            operationKeys: recoveryIntents.map((intent) => intent.key),');
    once('                        const streamResult = await processSSEStream({\n                            response,',
      '                        const streamResult = await processSSEStream({\n                            recoveryIntents,\n                            response,');
  } else if (name === 'future/services/assets.mjs') {
    once("query: (id)=>({\n                        url: `/upload/files/${id}`,\n                        method: 'DELETE'\n                    }),", `queryFn: async (id) => {
                    try {
                        const data = await runMediaIntent({ url: window.strapi.backendURL + '/upload/files/' + id, method: 'DELETE', shape: 'single' }, (key) => getFetchClient().del('/upload/files/' + id, { headers: { 'Idempotency-Key': key }, signal: AbortSignal.timeout(30000) }).then((response) => response.data));
                        return { data };
                    } catch (error) { return { error: { name: error.name, message: error.message } }; }
                },`);
    once("query: ({ fileIds, folderIds })=>({\n                        url: '/upload/actions/bulk-delete',\n                        method: 'POST',\n                        data: {\n                            fileIds,\n                            folderIds\n                        }\n                    }),", `queryFn: async ({ fileIds, folderIds, operationKey }) => {
                    try {
                        const result = await runBulkDeleteIntent({ payload: { fileIds, folderIds }, key: operationKey }, (key, payload) => getFetchClient().post('/upload/actions/bulk-delete', payload, { headers: { 'Idempotency-Key': key }, signal: AbortSignal.timeout(30000) }).then((response) => response.data.data));
                        return { data: { data: result } };
                    } catch (error) { return { error: { name: error.name, message: error.message } }; }
                },`);
    code = "import { getFetchClient } from '@strapi/admin/strapi-admin';\n" + code;
  }
  return "import { runMediaIntent, runBulkDeleteIntent, bulkSelectionKey, prepareUrlUploadIntents, observeUrlUploadEvent, requireUrlStreamCompletion } from '@gthf/media-recovery';\n" + code;
}
export function adminRecoveryPlugin(root: string) {
  const packageRoot = path.dirname(require.resolve('@strapi/upload/package.json'));
  const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageInfo.version !== '5.52.3') throw new Error('Review the media adapter before changing Strapi upload version');
  const adminRoot = path.dirname(require.resolve('@strapi/admin/package.json'));
  const adminInfo = JSON.parse(fs.readFileSync(path.join(adminRoot, 'package.json'), 'utf8'));
  if (adminInfo.version !== '5.52.3') throw new Error('Review the media adapter before changing Strapi admin version');
  for (const name of Object.keys(ADMIN_FETCH_CONTRACTS)) adaptAdminFetchClient(fs.readFileSync(path.join(adminRoot, 'dist/admin', name), 'utf8'), name);
  // Validate every module, including the inactive beta UI, before starting a build.
  for (const name of Object.keys(ADMIN_CONTRACTS)) adaptAdminUpload(fs.readFileSync(path.join(packageRoot, 'dist/admin', name), 'utf8'), name);
  return { name: 'gthf-media-recovery', enforce: 'pre' as const,
    transform(source: string, id: string) {
      const file = id.split('?')[0];
      const adminMarker = '/@strapi/admin/dist/admin/';
      const adminIndex = file.lastIndexOf(adminMarker);
      if (adminIndex >= 0) {
        const name = file.slice(adminIndex + adminMarker.length);
        return ADMIN_FETCH_CONTRACTS[name] ? { code: adaptAdminFetchClient(source, name), map: null } : null;
      }
      const marker = '/@strapi/upload/dist/admin/';
      const index = file.lastIndexOf(marker);
      if (index < 0) return null;
      const name = file.slice(index + marker.length);
      return ADMIN_CONTRACTS[name] ? { code: adaptAdminUpload(source, name), map: null } : null;
    },
  };
}
