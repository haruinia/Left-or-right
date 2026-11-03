import { state } from './state.js';

export function transcriptionGateway() {
  return String(window.__GATEWAY_URL__ || location.origin).replace(/\/$/, '');
}

export function transcriptionGatewayKey() {
  return window.__GATEWAY_KEY__ || state.gatewayApiKey || '';
}

export async function asrRequest(path, { method = 'GET', body } = {}) {
  const key = transcriptionGatewayKey();
  const response = await fetch(`${transcriptionGateway()}${path}`, {
    method,
    cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'X-API-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('本地服务返回了无效响应。'); }
  if (!response.ok) {
    const detail = result.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(item => item.msg).filter(Boolean).join('；') : `请求失败（${response.status}）。`);
  }
  return result;
}
