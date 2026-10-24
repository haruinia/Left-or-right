const defaultGatewayOrigin = "http://127.0.0.1:9958";

// Under the desktop shell the page is loaded from disk, so window.location.origin
// is "null" and cannot locate the gateway; the shell injects its configured URL.
function shellGatewayOrigin() {
  const injected = typeof window.__GATEWAY_URL__ === "string" ? window.__GATEWAY_URL__.trim() : "";
  if (!injected) return "";
  try {
    return new URL(injected).origin;
  } catch (error) {
    return "";
  }
}

function initialApiOrigin() {
  const stored = readStoredGatewayOrigin();
  if (stored) return stored;
  const fromShell = shellGatewayOrigin();
  if (fromShell) return fromShell;
  const pageOrigin = window.location.origin;
  if (pageOrigin && pageOrigin !== "null") return pageOrigin;
  return defaultGatewayOrigin;
}

// sessionStorage throws on a file:// origin in some Chromium builds, which is
// exactly where the desktop shell runs the page. The key is optional there
// anyway — the shell injects it — so a failure must not break startup.
function readStoredGatewayKey() {
  try {
    return sessionStorage.getItem("gatewayApiKey") || "";
  } catch (error) {
    return "";
  }
}

function writeStoredGatewayKey(value) {
  try {
    if (value) sessionStorage.setItem("gatewayApiKey", value);
    else sessionStorage.removeItem("gatewayApiKey");
    return true;
  } catch (error) {
    return false;
  }
}

function readStoredGatewayOrigin() {
  try {
    const stored = sessionStorage.getItem("gatewayApiOrigin") || "";
    return stored ? new URL(stored).origin : "";
  } catch (error) {
    return "";
  }
}

function writeStoredGatewayOrigin(value) {
  try {
    if (value) sessionStorage.setItem("gatewayApiOrigin", value);
    else sessionStorage.removeItem("gatewayApiOrigin");
    return true;
  } catch (error) {
    return false;
  }
}

const initialRole = new URLSearchParams(window.location.search).get("role");

const state = {
  job: null,
  candidate: null,
  interview: null,
  socket: null,
  socketToken: 0,
  preparingInterview: false,
  prepareSessionToken: 0,
  seq: 1,
  turns: 0,
  currentSpeaker: initialRole === "interviewer" ? "interviewer" : "candidate",
  selectedQuestionSource: "interviewer",
  selectedProbeTarget: null,
  selectedProbeChainId: null,
  selectedCompetency: null,
  currentQuestionOption: null,
  nextOptions: null,
  renderedOptions: [],
  scanningRepoMemory: false,
  deletingCandidateMemory: false,
  questionBank: null,
  steeringFocus: "balanced",
  debugTextInputEnabled: true,
  interviewEnded: false,
  endingInterview: false,
  reportReady: false,
  reportPollTimer: null,
  reportPollAttempts: 0,
  reportRefreshEpoch: 0,
  reportRefreshInFlight: false,
  reportDownloadInFlight: new Set(),
  startedAt: 0,
  // One entry per capture channel. Single-source capture keeps exactly one
  // ("mic"); dual-path capture adds a "loopback" channel carrying the remote
  // meeting audio, which is the candidate.
  micChannels: [],
  micDualCapture: false,
  micStarting: false,
  micStartToken: 0,
  micRecording: false,
  micError: "",
  documentParsingCount: 0,
  documentParseEpoch: 0,
  runtimeCheckToken: 0,
  modelCheckToken: 0,
  asrCheckToken: 0,
  lastRuntimeCheckAt: 0,
  apiOrigin: initialApiOrigin(),
  gatewayApiKey: readStoredGatewayKey(),
};

const micSampleRate = 16000;
const micChunkSamples = Math.floor(micSampleRate / 4);
const micVoiceRmsThreshold = 0.012;
// Device labels that mean "this input is really the system output looped back",
// which is how the candidate's voice becomes separable on macOS.
const loopbackDeviceHints = [
  "blackhole",
  "loopback",
  "soundflower",
  "vb-cable",
  "vb-audio",
  "virtual audio",
  "existential audio",
  "多输出",
  "虚拟声卡",
];
const answerMinChars = 20;
const maxDocumentUploadBytes = 25 * 1024 * 1024;
const maxLiveFeedEvents = 120;
const queuedReportPollIntervalMs = 3000;
const queuedReportMaxPollAttempts = 30;
const documentParseTimeoutMs = 45_000;
const prepareSessionTimeoutMs = 90_000;
const reportDownloadTimeoutMs = 30_000;
const externalCheckTimeoutMs = 65_000;
const supportedDocumentSuffixes = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".log",
  ".pdf",
  ".doc",
  ".docx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
]);
const supportedDocumentMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const fallbackGatewayOrigins = [
  shellGatewayOrigin(),
  readStoredGatewayOrigin(),
  defaultGatewayOrigin,
  "http://localhost:9958",
].filter((origin, index, origins) => origin && origins.indexOf(origin) === index);


export {
  writeStoredGatewayKey,
  writeStoredGatewayOrigin,
  answerMinChars,
  documentParseTimeoutMs,
  externalCheckTimeoutMs,
  fallbackGatewayOrigins,
  initialRole,
  maxDocumentUploadBytes,
  maxLiveFeedEvents,
  micChunkSamples,
  micSampleRate,
  loopbackDeviceHints,
  micVoiceRmsThreshold,
  prepareSessionTimeoutMs,
  queuedReportMaxPollAttempts,
  queuedReportPollIntervalMs,
  reportDownloadTimeoutMs,
  state,
  supportedDocumentMimeTypes,
  supportedDocumentSuffixes,
};
