import { gatewayKey } from './dom.js';
import { checkRuntime } from './runtime.js';
import { fallbackGatewayOrigins, state, writeStoredGatewayKey, writeStoredGatewayOrigin } from './state.js';
import { appendEvent, escapeHtml } from './ui.js';

async function readErrorMessage(response) {
  const fallback = `HTTP ${response.status}`;
  const text = await response.text();
  if (!text.trim()) return fallback;
  try {
    const payload = JSON.parse(text);
    const detail = payload.detail;
    if (Array.isArray(detail)) {
      return detail.map(formatApiDetailItem).filter(Boolean).join("；") || fallback;
    }
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch (error) {
    return text;
  }
  return text;
}

async function readJsonResponse(response, fallbackMessage = "接口响应不是有效 JSON") {
  const text = await response.text();
  if (!text.trim()) throw new Error(`${fallbackMessage}：响应为空。`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${fallbackMessage}：${text.slice(0, 160)}`);
  }
}

function formatApiDetailItem(item) {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return String(item || "").trim();
  const path = Array.isArray(item.loc)
    ? item.loc.filter((part) => part !== "body" && part !== "query").join(".")
    : "";
  const message =
    typeof item.msg === "string" && item.msg.trim() ? item.msg : JSON.stringify(item);
  return [path, message].filter(Boolean).join(": ");
}

function errorText(error) {
  if (error && error.name === "AbortError") {
    return "请求超时，请确认本地服务仍在运行，或稍后重试。";
  }
  const message = error && error.message ? error.message : String(error);
  if (/signal is aborted|aborted without reason/i.test(message)) {
    return "请求被浏览器中止，通常是前端超时或重复触发检查导致。";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "无法连接到本地服务，请确认 gateway 正在运行后重试。";
  }
  return message;
}

function attemptedGatewayOriginsText() {
  return gatewayOrigins().join("、");
}

function gatewayHelpText() {
  return `请确认已运行 python scripts/run_gateway.py；页面正在尝试连接：${attemptedGatewayOriginsText()}。`;
}

function gatewayFailureTitle(error) {
  return `服务不可达：${errorText(error)}。${gatewayHelpText()}`;
}

function gatewayOrigins() {
  return [state.apiOrigin, ...fallbackGatewayOrigins].filter(
    (origin, index, origins) => origin && origins.indexOf(origin) === index
  );
}

function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${state.apiOrigin}${normalizedPath}`;
}

function gatewayOriginFromResponse(response, fallbackOrigin) {
  try {
    return new URL(response.url).origin;
  } catch (error) {
    return fallbackOrigin;
  }
}

function authQueryParams() {
  return state.gatewayApiKey ? { api_key: state.gatewayApiKey } : {};
}

function gatewayUrl(path) {
  const url = new URL(apiUrl(path));
  Object.entries(authQueryParams()).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function gatewayHeaders(headers = {}) {
  return state.gatewayApiKey ? { ...headers, "X-API-Key": state.gatewayApiKey } : headers;
}

function wsUrl(path) {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function websocketProtocols() {
  if (!state.gatewayApiKey) return undefined;
  return [`gateway-key.${base64UrlEncode(state.gatewayApiKey)}`];
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

async function discoverGateway() {
  const failures = [];
  for (const origin of gatewayOrigins()) {
    try {
      const response = await fetchWithTimeout(`${origin}/health`, { cache: "no-store" });
      if (!response.ok) {
        failures.push(`${origin}: HTTP ${response.status}`);
        continue;
      }
      const status = await readJsonResponse(response, "服务健康检查响应不是有效 JSON");
      if (status.service !== "shuihuo-killer-gateway") {
        failures.push(`${origin}: 不是左右 gateway`);
        continue;
      }
      const previousOrigin = state.apiOrigin;
      const resolvedOrigin = gatewayOriginFromResponse(response, origin);
      state.apiOrigin = resolvedOrigin;
      if (previousOrigin !== resolvedOrigin) {
        appendEvent(
          "服务检查",
          `已自动切换到本地 gateway：${escapeHtml(resolvedOrigin)}`,
          "green"
        );
      }
      return status;
    } catch (error) {
      failures.push(`${origin}: ${errorText(error)}`);
    }
  }
  throw new Error(failures.join("；") || "gateway unreachable");
}

async function fetchGateway(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const response = await fetchWithTimeout(
    apiUrl(path),
    {
      ...fetchOptions,
      headers: gatewayHeaders(fetchOptions.headers || {}),
    },
    timeoutMs
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return response;
}

async function fetchGatewayJson(path, options = {}) {
  const response = await fetchGateway(path, options);
  return readJsonResponse(response);
}

async function postJson(url, payload, options = {}) {
  const response = await fetchGateway(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...options,
  });
  return readJsonResponse(response);
}

function saveGatewayApiKey() {
  state.gatewayApiKey = gatewayKey.value.trim();
  const stored = writeStoredGatewayKey(state.gatewayApiKey);
  if (state.gatewayApiKey) {
    appendEvent(
      "Gateway Key",
      stored ? "已保存到当前浏览器会话。" : "本次会话已生效（当前环境无法持久化）。",
      "green"
    );
  } else {
    appendEvent("Gateway Key", "已清除当前浏览器会话中的 key。");
  }
  checkRuntime();
}

function saveGatewayConnection() {
  const originInput = document.querySelector("#gatewayOrigin");
  const raw = originInput ? originInput.value.trim() : "";
  if (raw) {
    try {
      const origin = new URL(raw.includes("://") ? raw : `http://${raw}`).origin;
      state.apiOrigin = origin;
      writeStoredGatewayOrigin(origin);
      if (originInput) originInput.value = origin;
      appendEvent("API 接入", `已使用网关地址 ${escapeHtml(origin)}。`, "green");
    } catch (error) {
      appendEvent("API 接入", "网关地址无效，请填写形如 http://127.0.0.1:9958 的地址。", "red");
      return;
    }
  }
  saveGatewayApiKey();
}


export {
  apiUrl,
  attemptedGatewayOriginsText,
  authQueryParams,
  base64UrlEncode,
  discoverGateway,
  errorText,
  fetchGateway,
  fetchGatewayJson,
  fetchWithTimeout,
  formatApiDetailItem,
  gatewayFailureTitle,
  gatewayHeaders,
  gatewayHelpText,
  gatewayOriginFromResponse,
  gatewayOrigins,
  gatewayUrl,
  postJson,
  readErrorMessage,
  readJsonResponse,
  saveGatewayApiKey,
  saveGatewayConnection,
  websocketProtocols,
  wsUrl,
};
