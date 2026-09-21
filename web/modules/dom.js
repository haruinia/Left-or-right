const setupForm = document.querySelector("#setupForm");
const interviewForm = document.querySelector("#interviewForm");
const jdText = document.querySelector("#jdText");
const resumeText = document.querySelector("#resumeText");
const extractedJob = document.querySelector("#extractedJob");
const extractedCandidate = document.querySelector("#extractedCandidate");
const extractionConfidence = document.querySelector("#extractionConfidence");
const currentQuestionText = document.querySelector("#currentQuestionText");
const currentQuestionMeta = document.querySelector("#currentQuestionMeta");
const nextOptionList = document.querySelector("#nextOptionList");
const nextOptionCount = document.querySelector("#nextOptionCount");
const debugTextPanel = document.querySelector("#debugTextPanel");
const currentQuestion = document.querySelector("#currentQuestion");
const answerText = document.querySelector("#answerText");
const questionCharCount = document.querySelector("#questionCharCount");
const answerCharCount = document.querySelector("#answerCharCount");
const scanRepoMemory = document.querySelector("#scanRepoMemory");
const deleteCandidateMemory = document.querySelector("#deleteCandidateMemory");
const memoryActionStatus = document.querySelector("#memoryActionStatus");
const longTermMemoryConsent = document.querySelector("#longTermMemoryConsent");
const answerEchoMeta = document.querySelector("#answerEchoMeta");
const answerEchoText = document.querySelector("#answerEchoText");
const setupStatus = document.querySelector("#setupStatus");
const runtimeStatus = document.querySelector("#runtimeStatus");
const modelStatus = document.querySelector("#modelStatus");
const asrStatus = document.querySelector("#asrStatus");
const refreshStatus = document.querySelector("#refreshStatus");
const checkModel = document.querySelector("#checkModel");
const checkAsr = document.querySelector("#checkAsr");
const gatewayKey = document.querySelector("#gatewayKey");
const saveGatewayKey = document.querySelector("#saveGatewayKey");
const loadSampleButton = document.querySelector("#loadSample");
const liveStatus = document.querySelector("#liveStatus");
const micStatus = document.querySelector("#micStatus");
const competencyList = document.querySelector("#competencyList");
const probeList = document.querySelector("#probeList");
const probeCount = document.querySelector("#probeCount");
const memoryList = document.querySelector("#memoryList");
const memoryCount = document.querySelector("#memoryCount");
const examPanel = document.querySelector("#examPanel");
const examStatus = document.querySelector("#examStatus");
const chainList = document.querySelector("#chainList");
const chainCount = document.querySelector("#chainCount");
const credibilityLevel = document.querySelector("#credibilityLevel");
const credibilityBox = document.querySelector("#credibilityBox");
const reportPanel = document.querySelector("#reportPanel");
const reportLinks = document.querySelector("#reportLinks");
const liveFeed = document.querySelector("#liveFeed");
const metricJob = document.querySelector("#metricJob");
const metricCandidate = document.querySelector("#metricCandidate");
const metricTurns = document.querySelector("#metricTurns");
const roleLinks = document.querySelector("#roleLinks");
const prepareInterview = document.querySelector("#prepareInterview");
const sendAnswer = document.querySelector("#sendAnswer");
const startMic = document.querySelector("#startMic");
const stopMic = document.querySelector("#stopMic");
const reconnectSocket = document.querySelector("#reconnectSocket");
const manualProbe = document.querySelector("#manualProbe");
const endInterview = document.querySelector("#endInterview");
const controlHint = document.querySelector("#controlHint");
const speakerCandidate = document.querySelector("#speakerCandidate");
const speakerInterviewer = document.querySelector("#speakerInterviewer");


export {
  answerCharCount,
  answerEchoMeta,
  answerEchoText,
  answerText,
  asrStatus,
  chainCount,
  chainList,
  checkAsr,
  checkModel,
  competencyList,
  controlHint,
  credibilityBox,
  credibilityLevel,
  currentQuestion,
  currentQuestionMeta,
  currentQuestionText,
  debugTextPanel,
  endInterview,
  examPanel,
  examStatus,
  extractedCandidate,
  extractedJob,
  extractionConfidence,
  gatewayKey,
  interviewForm,
  jdText,
  liveFeed,
  liveStatus,
  longTermMemoryConsent,
  loadSampleButton,
  manualProbe,
  deleteCandidateMemory,
  memoryActionStatus,
  memoryCount,
  memoryList,
  metricCandidate,
  metricJob,
  metricTurns,
  micStatus,
  modelStatus,
  nextOptionCount,
  nextOptionList,
  prepareInterview,
  probeCount,
  probeList,
  questionCharCount,
  reconnectSocket,
  refreshStatus,
  reportLinks,
  reportPanel,
  resumeText,
  roleLinks,
  runtimeStatus,
  saveGatewayKey,
  scanRepoMemory,
  sendAnswer,
  setupForm,
  setupStatus,
  speakerCandidate,
  speakerInterviewer,
  startMic,
  stopMic,
};
