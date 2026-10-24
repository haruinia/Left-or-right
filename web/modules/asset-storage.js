// Shared gateway persistence. No network calls during module evaluation: a gateway
// failure must never prevent the screenshot home screen from loading.
import { fallbackGatewayOrigins, state } from "./state.js";

const migrations = new Map();
let discovery = null;
let discoveredOrigin = "";

async function gatewayOrigin() {
  if (discoveredOrigin && state.apiOrigin === discoveredOrigin) return discoveredOrigin;
  if (discovery) return discovery;
  const pending = (async () => {
    const candidates = [state.apiOrigin, window.__GATEWAY_URL__, ...fallbackGatewayOrigins]
      .filter((origin, index, values) => origin && values.indexOf(origin) === index);
    for (const candidate of candidates) {
      const origin = candidate.replace(/\/$/, "");
      if (!/^https?:\/\//.test(origin)) continue;
      // 设置页和学习资产同源：直接使用页面来源，静态页不能再冒充网关。
      if (typeof window !== "undefined" && window.location?.origin === origin
          && /^https?:$/.test(window.location.protocol)) {
        discoveredOrigin = origin;
        state.apiOrigin = origin;
        return origin;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(`${origin}/health`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) continue;
        const status = await response.json();
        if (status.service !== "shuihuo-killer-gateway") continue;
        let resolved = origin;
        try { resolved = new URL(response.url).origin; } catch { /* no redirect */ }
        discoveredOrigin = resolved;
        state.apiOrigin = resolved;
        return resolved;
      } catch { /* Try the next configured local endpoint. */ }
      finally { clearTimeout(timer); }
    }
    throw new Error("无法连接本地服务，学习资产尚未保存。请启动网关后重试。");
  })();
  discovery = pending;
  try { return await pending; }
  finally { if (discovery === pending) discovery = null; }
}

async function request(kind, action = "", body) {
  const origin = await gatewayOrigin();
  const key = state.gatewayApiKey || window.__GATEWAY_KEY__ || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/api/learning-assets/${kind}${action}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "X-API-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("网关认证失败，请在设置中检查访问密钥。");
      throw new Error(`学习资产${body === undefined ? "读取" : "保存"}失败（${response.status}），请重试。`);
    }
    try { return await response.json(); } catch {
      throw new Error("本地服务返回的学习资产格式不正确，请更新服务后重试。");
    }
  } catch (error) {
    if (error instanceof TypeError || error.name === "AbortError") {
      discoveredOrigin = "";
      throw new Error("无法连接本地服务，学习资产尚未保存。请启动网关后重试。", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function migrate(kind, legacyKey) {
  if (migrations.has(kind)) return migrations.get(kind);
  const pending = (async () => {
    let raw;
    let marker;
    try {
      raw = localStorage.getItem(legacyKey);
      marker = localStorage.getItem(`${legacyKey}_shared_v1`);
    } catch {
      // Some file:// Chromium builds disallow localStorage. Shared storage still works.
      return;
    }
    if (!raw || marker === "done") return;
    let items;
    try { items = JSON.parse(raw); } catch {
      throw new Error("旧学习资产数据无法解析，请先备份浏览器存储再重试。");
    }
    if (!Array.isArray(items)) throw new Error("旧学习资产格式不正确，请先备份再重试。");
    await request(kind, "/migrate", { items });
    // Keep the legacy snapshot as a backup; acknowledge only after durable server success.
    try { localStorage.setItem(`${legacyKey}_shared_v1`, "done"); } catch { /* safe to retry */ }
  })();
  migrations.set(kind, pending);
  pending.catch(() => { if (migrations.get(kind) === pending) migrations.delete(kind); });
  return pending;
}

export function createAssetStore(kind, legacyKey) {
  return {
    async list() {
      await migrate(kind, legacyKey);
      const payload = await request(kind);
      if (!Array.isArray(payload.items)) {
        throw new Error("本地服务返回的学习资产列表不完整，请更新服务后重试。");
      }
      return payload.items;
    },
    async put(item) {
      await migrate(kind, legacyKey);
      return (await request(kind, "/upsert", { item })).item;
    },
    async insertMissing(items) {
      await migrate(kind, legacyKey);
      return (await request(kind, "/migrate", { items })).imported;
    },
    async remove(id) {
      await migrate(kind, legacyKey);
      await request(kind, "/delete", { id });
      return true;
    },
    async clear() {
      await migrate(kind, legacyKey);
      await request(kind, "/clear", {});
      return true;
    },
    async review(id) {
      await migrate(kind, legacyKey);
      return (await request(kind, `/${encodeURIComponent(id)}/review`, {})).item;
    },
  };
}
