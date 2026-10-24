import { asrStatus, checkAsr, checkModel, modelStatus, refreshStatus, runtimeStatus } from './dom.js';
import { discoverGateway, errorText, fetchGatewayJson, gatewayFailureTitle, gatewayHelpText } from './gateway.js';
import { externalCheckTimeoutMs, state } from './state.js';
import { appendEvent, applyDebugTextVisibility, escapeHtml, setButtonBusy, setPill } from './ui.js';

function runtimeCheckStillCurrent(checkToken) {
  return checkToken === state.runtimeCheckToken;
}

function modelCheckStillCurrent(checkToken) {
  return checkToken === state.modelCheckToken;
}

function asrCheckStillCurrent(checkToken) {
  return checkToken === state.asrCheckToken;
}

function shouldRefreshRuntimeOnFocus() {
  if (document.visibilityState !== "visible") return false;
  const statusText = runtimeStatus.textContent || "";
  const staleMs = 30_000;
  return (
    !state.lastRuntimeCheckAt ||
    Date.now() - state.lastRuntimeCheckAt > staleMs ||
    statusText.includes("服务不可达") ||
    statusText.includes("状态未知")
  );
}

function refreshRuntimeIfVisible() {
  if (shouldRefreshRuntimeOnFocus()) checkRuntime();
}

async function checkRuntime() {
  const checkToken = state.runtimeCheckToken + 1;
  let gatewayError = null;
  state.runtimeCheckToken = checkToken;
  state.modelCheckToken += 1;
  state.asrCheckToken += 1;
  refreshStatus.disabled = true;
  setButtonBusy(refreshStatus, true);
  refreshStatus.title = "正在刷新服务、模型和 ASR 状态";
  setPill(runtimeStatus, "检查中", "live");
  setPill(modelStatus, "模型检查中", "live");
  setPill(asrStatus, "ASR 检查中", "live");
  try {
    const status = await discoverGateway();
    if (!runtimeCheckStillCurrent(checkToken)) return;
    setRuntimeStatusFromGateway(status);
  } catch (error) {
    if (!runtimeCheckStillCurrent(checkToken)) return;
    gatewayError = error;
    setRuntimeStatusGatewayUnavailable(error);
    setDependentStatusWaitingForGateway(error);
    appendEvent(
      "服务检查",
      `无法连接到本地 gateway。${escapeHtml(gatewayHelpText())}<br><span class="small">失败详情：${escapeHtml(errorText(error))}</span>`,
      "red"
    );
  }
  try {
    if (gatewayError) return;
    const config = await fetchGatewayJson("/api/config/status");
    if (!runtimeCheckStillCurrent(checkToken)) return;
    applyRuntimeConfig(config);
    applyModelStatusFromConfig(config);
    applyAsrStatusFromConfig(config);
  } catch (error) {
    if (!runtimeCheckStillCurrent(checkToken)) return;
    if (gatewayAuthError(error)) {
      showGatewayKeyRequired("服务检查", { model: true, asr: true });
    } else {
      const message = `配置状态读取失败：${errorText(error)}`;
      setPill(modelStatus, "模型状态未知", "");
      setStatusTitleFromMessage(modelStatus, message);
      setPill(asrStatus, "ASR 状态未知", "");
      setStatusTitleFromMessage(asrStatus, message);
    }
  } finally {
    if (!runtimeCheckStillCurrent(checkToken)) return;
    refreshStatus.disabled = false;
    setButtonBusy(refreshStatus, false);
    refreshStatus.title = "重新检查服务、模型和 ASR 状态";
  }
}

function setRuntimeStatusFromGateway(status) {
  state.lastRuntimeCheckAt = Date.now();
  setPill(
    runtimeStatus,
    status.status === "ok" ? "服务正常" : "服务异常",
    status.status === "ok" ? "ready" : ""
  );
  runtimeStatus.title = `当前 gateway：${state.apiOrigin}`;
}

function applyRuntimeConfig(config) {
  state.debugTextInputEnabled = config.debug_text_input_enabled !== false;
  applyDebugTextVisibility();
  // 模型表单由 model-config.js 负责填充；这里只刷新状态，避免覆盖未保存的草稿。
  const connectedModel = document.querySelector("#connectedModel");
  if (connectedModel) {
    connectedModel.textContent = config.llm_model
      ? `${config.llm_provider} · ${config.llm_model}`
      : "未配置模型";
  }
}

function setRuntimeStatusGatewayUnavailable(error) {
  state.lastRuntimeCheckAt = Date.now();
  setPill(runtimeStatus, "服务不可达", "");
  runtimeStatus.title = gatewayFailureTitle(error);
}

function applyModelStatusFromConfig(config) {
  const model = modelStatusFromConfig(config);
  setPill(modelStatus, model.text, model.ready ? "ready" : "");
  modelStatus.title = model.title || model.text;
}

function applyAsrStatusFromConfig(config) {
  const asr = asrStatusFromConfig(config);
  setPill(asrStatus, asr.text, asr.ready ? "ready" : "");
  asrStatus.title = asr.title || asr.text;
}

function dependencyStatusAlreadyVerified(peer) {
  const node = peer === "model" ? modelStatus : asrStatus;
  const text = node.textContent || "";
  return (
    node.classList.contains("ready") &&
    !text.includes("已配置，未测试") &&
    !text.includes("未配置") &&
    !text.includes("等待")
  );
}

async function refreshPeerDependencyStatusFromConfig(peer) {
  if (dependencyStatusAlreadyVerified(peer)) return;
  try {
    const config = await fetchGatewayJson("/api/config/status");
    if (dependencyStatusAlreadyVerified(peer)) return;
    if (peer === "model") {
      applyModelStatusFromConfig(config);
    } else if (peer === "asr") {
      applyAsrStatusFromConfig(config);
    }
  } catch (error) {
    if (gatewayAuthError(error)) {
      showGatewayKeyRequired("配置刷新", { [peer]: true });
    } else {
      const message = `配置状态读取失败：${errorText(error)}`;
      if (peer === "model") {
        setPill(modelStatus, "模型状态未知", "");
        setStatusTitleFromMessage(modelStatus, message);
      } else if (peer === "asr") {
        setPill(asrStatus, "ASR 状态未知", "");
        setStatusTitleFromMessage(asrStatus, message);
      }
    }
  }
}

function setDependentStatusWaitingForGateway(error) {
  setModelStatusWaitingForGateway(error);
  setAsrStatusWaitingForGateway(error);
}

function setModelStatusWaitingForGateway(error) {
  setPill(modelStatus, "模型等待本地服务", "");
  setStatusTitleFromMessage(modelStatus, gatewayFailureTitle(error));
}

function setAsrStatusWaitingForGateway(error) {
  setPill(asrStatus, "ASR 等待本地服务", "");
  setStatusTitleFromMessage(asrStatus, gatewayFailureTitle(error));
}

function gatewayUnavailableEventBody(error) {
  return `${escapeHtml(gatewayHelpText())}<br><span class="small">失败详情：${escapeHtml(errorText(error))}</span>`;
}

function gatewayAuthError(error) {
  const text = errorText(error).toLowerCase();
  return text.includes("401") || text.includes("unauthorized");
}

function showGatewayKeyRequired(title, targets = {}) {
  const message = "Gateway 已启用鉴权，请在顶部 Gateway Key 输入框保存 key。";
  if (targets.model) {
    setPill(modelStatus, "需要 Gateway Key", "");
    setStatusTitleFromMessage(modelStatus, message);
  }
  if (targets.asr) {
    setPill(asrStatus, "需要 Gateway Key", "");
    setStatusTitleFromMessage(asrStatus, message);
  }
  appendEvent(title, message, "red");
}

function setStatusTitleFromMessage(node, message) {
  node.title = String(message || "").trim() || node.textContent.trim();
}

async function checkLlmConnection() {
  const checkToken = state.modelCheckToken + 1;
  state.modelCheckToken = checkToken;
  checkModel.disabled = true;
  setButtonBusy(checkModel, true);
  checkModel.title = "正在调用真实模型检查连接";
  setPill(modelStatus, "模型连接检查中", "live");
  try {
    try {
      const status = await discoverGateway();
      if (!modelCheckStillCurrent(checkToken)) return;
      setRuntimeStatusFromGateway(status);
      await refreshPeerDependencyStatusFromConfig("asr");
      if (!modelCheckStillCurrent(checkToken)) return;
    } catch (error) {
      if (!modelCheckStillCurrent(checkToken)) return;
      setRuntimeStatusGatewayUnavailable(error);
      setModelStatusWaitingForGateway(error);
      appendEvent("模型检查", gatewayUnavailableEventBody(error), "red");
      return;
    }
    const result = await fetchGatewayJson("/api/config/llm/check", {
      method: "POST",
      timeoutMs: externalCheckTimeoutMs,
    });
    if (!modelCheckStillCurrent(checkToken)) return;
    setPill(modelStatus, result.ok ? "模型连接正常" : "模型连接异常", result.ok ? "ready" : "");
    setStatusTitleFromMessage(modelStatus, result.message);
    appendEvent("模型检查", escapeHtml(result.message), result.ok ? "green" : "red");
  } catch (error) {
    if (!modelCheckStillCurrent(checkToken)) return;
    if (gatewayAuthError(error)) {
      showGatewayKeyRequired("模型检查", { model: true });
    } else {
      const message = errorText(error);
      setPill(modelStatus, "模型连接异常", "");
      setStatusTitleFromMessage(modelStatus, message);
      appendEvent("模型检查", escapeHtml(message), "red");
    }
  } finally {
    if (modelCheckStillCurrent(checkToken)) {
      checkModel.disabled = false;
      setButtonBusy(checkModel, false);
      checkModel.title = "手动调用真实模型检查连接";
    }
  }
}

async function checkAsrReadiness() {
  const checkToken = state.asrCheckToken + 1;
  state.asrCheckToken = checkToken;
  checkAsr.disabled = true;
  setButtonBusy(checkAsr, true);
  checkAsr.title = "正在检查 ASR 配置、依赖和 Token";
  setPill(asrStatus, "ASR 检查中", "live");
  try {
    try {
      const status = await discoverGateway();
      if (!asrCheckStillCurrent(checkToken)) return;
      setRuntimeStatusFromGateway(status);
      await refreshPeerDependencyStatusFromConfig("model");
      if (!asrCheckStillCurrent(checkToken)) return;
    } catch (error) {
      if (!asrCheckStillCurrent(checkToken)) return;
      setRuntimeStatusGatewayUnavailable(error);
      setAsrStatusWaitingForGateway(error);
      appendEvent("ASR 检查", gatewayUnavailableEventBody(error), "red");
      return;
    }
    const result = await fetchGatewayJson("/api/config/asr/check", {
      method: "POST",
      timeoutMs: externalCheckTimeoutMs,
    });
    if (!asrCheckStillCurrent(checkToken)) return;
    setPill(asrStatus, asrCheckStatusText(result), result.ok ? "ready" : "");
    setStatusTitleFromMessage(asrStatus, result.message);
    appendEvent("ASR 检查", escapeHtml(result.message), result.ok ? "green" : "red");
  } catch (error) {
    if (!asrCheckStillCurrent(checkToken)) return;
    if (gatewayAuthError(error)) {
      showGatewayKeyRequired("ASR 检查", { asr: true });
    } else {
      const message = errorText(error);
      setPill(asrStatus, "ASR 异常", "");
      setStatusTitleFromMessage(asrStatus, message);
      appendEvent("ASR 检查", escapeHtml(message), "red");
    }
  } finally {
    if (asrCheckStillCurrent(checkToken)) {
      checkAsr.disabled = false;
      setButtonBusy(checkAsr, false);
      checkAsr.title = "手动检查 ASR 配置、依赖和 Token";
    }
  }
}

function asrCheckStatusText(result) {
  if (!result.ok) return "ASR 异常";
  if (result.mode === "fixed_token_auto_ready") return "ASR 固定 Token 已配置，自动刷新可用";
  if (result.mode === "token_ready") return "ASR Token 可生成，未跑音频";
  if (result.mode === "fixed_token") return "ASR 固定 Token 已配置";
  if (result.mode === "configured") return "ASR 配置存在，未跑音频";
  return "ASR 检查通过";
}

function modelStatusFromConfig(config) {
  if (config.llm_provider === "mock") {
    return { text: "模型模拟模式", ready: false };
  }
  if (config.llm_provider === "openai_compatible") {
    const ready = config.llm_base_url_configured && config.llm_api_key_configured;
    const modelName = config.llm_model || "未知模型";
    return {
      text: ready ? `模型 ${modelName} 已配置，未测试` : "模型未配置完整",
      ready: false,
      title: ready
        ? "本地服务已连接；模型配置已填写但尚未调用真实模型测试。点击“检查模型”后才会确认模型连接。"
        : "请检查 LLM_BASE_URL 和 LLM_API_KEY。",
    };
  }
  return { text: "模型状态未知", ready: false };
}

function asrStatusFromConfig(config) {
  if (config.asr_provider === "aliyun_nls_ws") {
    const tokenReady =
      config.aliyun_nls_token_configured || config.aliyun_nls_token_auto_configured;
    const ready =
      config.aliyun_nls_app_key_configured &&
      tokenReady &&
      config.aliyun_nls_endpoint_configured;
    return {
      text: ready
        ? tokenReady && !config.aliyun_nls_token_configured
          ? "ASR 阿里云 NLS 已配置（自动 Token），未测试"
          : "ASR 阿里云 NLS 已配置，未测试"
        : "ASR 阿里云 NLS 未配置完整",
      ready: false,
      title: ready
        ? "本地服务已连接；ASR 配置已填写但尚未验证依赖、Token 和音频链路。点击“检查 ASR”后才会确认。"
        : "请检查阿里云 NLS AppKey、Endpoint 和 Token/AK 配置。",
    };
  }
  if (config.asr_provider === "aliyun_ws") {
    const ready =
      config.aliyun_asr_api_key_configured && config.aliyun_asr_endpoint_configured;
    return {
      text: ready
        ? "ASR 阿里云 DashScope 已配置，未测试"
        : "ASR 阿里云 DashScope 未配置完整",
      ready: false,
      title: ready
        ? "本地服务已连接；ASR 配置已填写但尚未验证依赖和音频链路。点击“检查 ASR”后才会确认。"
        : "请检查阿里云 DashScope API Key 和 Endpoint。",
    };
  }
  if (config.asr_provider === "http") {
    const ready = config.asr_base_url_configured;
    return {
      text: ready ? "ASR HTTP 已配置，未测试" : "ASR HTTP 未配置完整",
      ready: false,
      title: ready
        ? "本地服务已连接；ASR HTTP 地址已填写但尚未验证。点击“检查 ASR”后才会确认。"
        : "请检查 ASR_BASE_URL。",
    };
  }
  if (config.asr_provider === "stub") {
    return { text: "ASR 模拟模式", ready: false };
  }
  return { text: "ASR 状态未知", ready: false };
}


export {
  applyAsrStatusFromConfig,
  applyModelStatusFromConfig,
  applyRuntimeConfig,
  asrCheckStatusText,
  asrCheckStillCurrent,
  asrStatusFromConfig,
  checkAsrReadiness,
  checkLlmConnection,
  checkRuntime,
  dependencyStatusAlreadyVerified,
  gatewayAuthError,
  gatewayUnavailableEventBody,
  modelCheckStillCurrent,
  modelStatusFromConfig,
  refreshPeerDependencyStatusFromConfig,
  refreshRuntimeIfVisible,
  runtimeCheckStillCurrent,
  setAsrStatusWaitingForGateway,
  setDependentStatusWaitingForGateway,
  setModelStatusWaitingForGateway,
  setRuntimeStatusFromGateway,
  setRuntimeStatusGatewayUnavailable,
  setStatusTitleFromMessage,
  shouldRefreshRuntimeOnFocus,
  showGatewayKeyRequired,
};
