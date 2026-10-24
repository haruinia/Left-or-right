# 左右 · ZUOYOU

思路，就在旁边。以半透明白色 Electron 悬浮窗陪伴刷题。

截图问 AI，用于刷题和笔面试复习。桌面首页保留一个 Logo、讲解区、补充问题，并常驻截图、发送、隐藏/显示、退出、新对话和清空截图。其余收在「全部快捷键」里。不再设置截图、发送或新对话按钮。

- **Web 设置 `/settings`**：专业 / 方向、编程语言、复习目标、讲解方式、补充偏好和快捷键统一在这里维护。保存后，从下一次提问开始生效。快捷键支持点击录入组合键、冲突检查和恢复默认，桌面约 4 秒自动同步。
- **桌面使用**：`⌘⇧U` 截图，可连续截多张后用 `⌘⇧Enter` 一次发送；`⌘⇧H` 隐藏或显示窗口，`⌘⇧Q` 退出，`⌘⇧N` 开始新对话，`⌘⇧⌫` 只清空截图。按住 `⌘⇧Space` 才能点击面板。全屏截图和移动窗口收在「全部快捷键」里。截图时临时隐藏面板，截图后恢复。浏览器版可粘贴或拖入多张图片。
- **对话**：最多 8 张截图一起发送；发送失败保留草稿以便重试；同一题的追问会继续附上本题截图。清空截图只去掉图片，新对话才会清掉对话和截图。对话仅保留在本次页面会话中。
- **旧版功能**：岗位、简历、语音与面试评估收纳在设置页的折叠区域，工作台仍可通过 `/cockpit` 单独打开。
- **模型接入**：在设置页统一管理接入地址、协议、模型、输出额度和密钥，支持导入 JSON 后保存启用；密钥只保存在本机。桌面快捷设置显示当前模型，并可跳转到设置页。模型为 mock 时首页会明确显示演示模式。

<div align="center">

# 水货杀手 🎯

**AI 实时面试助手 · 反注水 / 反作弊评估系统**

面试时帮你实时深挖追问，面试后给出有证据、可审计的评分报告——
专治简历注水、背稿套话，以及用 AI 作弊工具（如 gankintview）现场代答。

</div>

---

## 这是什么

一套**本地优先**的 Python 系统，覆盖一场面试的完整链路：

```
JD + 简历  →  实时语音转写  →  AI 深挖追问  →  AIGC 作弊检测  →  结构化评分  →  可审计报告(HTML/PDF)
```

- **实时**：边面试边转写、边判断回答真伪、边生成下一个追问。
- **反注水**：对简历声明逐层追问，露馅即记录在案并扣分。
- **反作弊**：识别背稿、模板化套话、AI 现场代答，标记在报告醒目位置。
- **可审计**：每个分数都挂着原始回答证据，分数由代码重算，不靠大模型"拍脑袋"。
- **离线可跑**：没有大模型 / 语音服务时，系统用确定性规则兜底，链路照样走通。

---

## 核心亮点：公平且抗作弊的评分系统

这是本项目的灵魂。我们用 6 种典型候选人画像做过实证校准（见 [`scripts/eval_scoring.py`](scripts/eval_scoring.py)）：

| 候选人画像 | 得分 | 结果 | 说明 |
|---|---|---|---|
| 资深专家·回答简洁精确 | **75.6** | ✅ 合格 | 短而密的真本事不被误杀 |
| 优秀候选人·多轮深答 | **79.5** | ✅ 合格 | 有数据、有故障复盘 |
| 垃圾灌水·"你好你好" | 20.7 | ❌ 不合格 | |
| 简历注水·追问露馅 | 34.8 | ❌ 不合格 | 标注「第 N 层追问露馅」 |
| gankintview·照抄套话 | 18.6 | 🚩 不合格 | AIGC 全部标记 |
| gankintview·改写逃逸 | 21.2 | 🚩 不合格 | 元空话检测兜住 |

设计上解决了两个常见难题：

- **简洁 ≠ 低分**。中文技术回答信息密度极高，"P99 从 800ms 压到 120ms，用 Redis 预扣库存挡超卖" 短短一句胜过百字废话。评分以**可信度 + 信息密度**为主，不再按字数线性打分。
- **流畅 ≠ 高分**。又长又顺却通篇"三个层面""权衡的艺术""质的飞跃"的 AI 套话，会被**元空话检测**识破——长篇 + 零具体内容 + 抽象词堆砌 = 高度疑似作弊，直接打低分。
- **误报保护**：即便某条回答被 AIGC 标记，只要它含有具体数字 / 技术名词 / 故障细节，就只做温和提示而非一票否决，避免冤枉真专家。

> 评分有两层：大模型给出带证据的维度草稿 → Python 按权重重算总分，并对作弊 / 露馅信号封顶。大模型不可用时自动降级为确定性规则评分，报告会明确标注。

---

## 快速开始

需要 Python 3.11+。

```bash
# 1. 装环境
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# 2. 先跑一遍离线 demo，确认链路通（无需任何 API key，走本地 mock）
python scripts/run_offline_demo.py

# 3. 启动网关（含网页操作台）
python scripts/run_gateway.py
```

启动后打开：

| 地址 | 用途 |
|---|---|
| http://127.0.0.1:9958/ | 左右首页（截图问 AI） |
| http://127.0.0.1:9958/settings | 设置、模型接入、学习资产与快捷键 |
| http://127.0.0.1:9958/cockpit | 水货杀手面试工作台 |
| http://127.0.0.1:9958/docs | API 文档（Swagger） |

> 页面、模型配置接口和学习资产都在 `9958` 同一进程。端口被占用时加 `--port 9959` 即可，桌面端需在 `config.json` 里用同一个 `gatewayUrl`。

启动脚本会打印本地地址、模型 provider、ASR provider、数据库摘要——只显示"是否已配置"，**绝不打印任何 key / token / 密码**。

---

## 网页操作台怎么用

整个流程被精简成 **3 步**，开始面试后一切自动接管：

1. **准备**：粘贴或上传 JD 与简历（支持 txt / md / PDF / Word / 图片 OCR，单文件≤25MB），系统自动生成能力模型和题库。
2. **面试**：三栏「驾驶舱」布局——
   - 左栏：简历 / JD 参考面板（VS Code 风格折叠）
   - 中栏：当前问题 + 实时转写对话框（流式输出）
   - 右栏：深挖追问池 + 换题备选池（带刷新按钮，预备好题目零等待切换）
   - 自动采集麦克风（面试官）与扬声器（候选人），微信、腾讯会议都适用。
3. **报告**：结束后自动评分，生成简历风格的 HTML/PDF 报告，文件名直接体现结论——`合格-张三-82.pdf` / `不合格-李四-31.pdf`。

---

## 配置大模型与语音

### 大模型（LLM）

不配置 key 时系统走本地 mock，所有功能可演示。要接真实模型，设置一组 OpenAI 兼容的 `LLM_*` 环境变量（放 `.env` 或 shell）：

```bash
export LLM_PROVIDER=openai_compatible
export LLM_MODEL=mimo-v2.5-pro                 # 默认模型
export LLM_BASE_URL="https://token-plan-cn.xiaomimimo.com/v1"
export LLM_API_PATH="/chat/completions"
export LLM_API_KEY="your-key"
export LLM_AUTH_HEADER="api-key"
export LLM_RESPONSE_CONTENT_PATH="choices.0.message.content"
```

换供应商只改这几个变量即可。例如 DeepSeek：

```bash
export LLM_MODEL=deepseek-v4-pro
export LLM_BASE_URL="https://api.deepseek.com"
export LLM_AUTH_HEADER="Authorization"
export LLM_AUTH_SCHEME="Bearer"
```

配置后用冒烟脚本验证：

```bash
python scripts/check_llm.py
# ✅ "LLM smoke test ok."                          → 真实模型已接通
# ⚪ "LLM mock mode ok. No real model endpoint..."  → 仍在 mock 模式
```

连不上就跑 `scripts/diagnose_llm_network.py`（查 DNS/TCP/TLS）；报 401 就跑 `scripts/diagnose_llm_auth.py`（试鉴权 header 变体）。两个脚本都不会打印 key。

### 实时语音（ASR）

默认 `ASR_PROVIDER=stub` 只验证链路。要真实转写：

| Provider | 适用 |
|---|---|
| `ASR_PROVIDER=sherpa_onnx` | **推荐本地实时**：sherpa-onnx 流式 Paraformer，无云端往返 |
| `ASR_PROVIDER=http` | 任意 OpenAI 风格的 HTTP ASR 服务，响应字段路径可配 |
| `ASR_PROVIDER=aliyun_ws` | 阿里云 DashScope Paraformer 实时 WebSocket（需百炼 API Key） |
| `ASR_PROVIDER=aliyun_nls_ws` | 阿里云智能语音交互 NLS WebSocket（用 AppKey + Token，或 AccessKey 自动签发 Token） |

本地 sherpa 一次性准备：

```bash
pip install -e ".[sherpa]"
python scripts/download_sherpa_asr_model.py
export ASR_PROVIDER=sherpa_onnx
python scripts/run_gateway.py
```

对应冒烟脚本：`scripts/check_aliyun_asr.py`、`scripts/check_aliyun_nls_asr.py`、`scripts/create_aliyun_nls_token.py`。

> **人声分离**：点「开始采集」时，若检测到 BlackHole / Loopback 等虚拟声卡，会自动双声道——麦克风记为面试官（你），会议扬声器记为候选人（对方）。没有虚拟声卡时，也可在屏幕共享里勾选系统声音；否则退回单麦，并可用手动切换说话人。实时接口本身不做声纹分离。

> 如需 HTTP 声纹分离服务，配置 `SPEAKER_DIARIZATION_PROVIDER=http`。

---

## 用 Docker Compose 运行

一键拉起网关 + PostgreSQL + Redis + MinIO（S3 兼容）：

```bash
docker compose up --build           # 网关默认在 http://127.0.0.1:8000/
```

端口冲突时自定义宿主机端口：

```bash
GATEWAY_PORT=18000 POSTGRES_PORT=15432 REDIS_PORT=16379 \
MINIO_PORT=19000 MINIO_CONSOLE_PORT=19001 docker compose up --build
```

Compose 下网关默认用 PostgreSQL（`db/postgres/001_core_schema.sql` 初始化）；非 Docker 本地仍默认 SQLite，方便快速 demo。装了 pgvector 可设 `JD_VECTOR_BACKEND=pgvector` 启用追问范式的向量检索。配置对象存储（`OBJECT_STORAGE_*`）后报告产物会上传到 MinIO。

---

## 架构概览

```
services/
├─ gateway/               FastAPI 入口：HTTP API + WebSocket 实时流
├─ interview_orchestrator/ 面试流程协调（追问 → 检测 → 评分串联）
├─ asr_service/           语音识别（stub / HTTP / 阿里云）
├─ probe_service/         追问生成 + 可信度评估
├─ aigc_detect_service/   作弊检测（模板相似度 + 元空话 + LLM 审查）
├─ scoring_service/       评分核心（LLM 草稿 + 确定性重算与封顶）
├─ report_service/        报告生成（HTML / PDF / JSON）
├─ jd_kb_service/         岗位知识库与能力模型
├─ document_service/      JD / 简历解析（含 OCR）
└─ offline_worker/        离线评分任务队列（local / Redis / Celery）

libs/schemas/             跨服务 Pydantic v2 数据契约（严格校验）
prompts/                  运行时 LLM 提示词（不硬编码在代码里）
web/index.html            网页操作台（原生 JS，无框架）
```

设计原则：**所有服务边界用 Pydantic 严格校验**（空文本、重复 ID、越界时间戳、未覆盖的 turn 等一律拒绝），保证报告里每一条引用都可追溯。

---

## 主要 API

| 方法 & 路径 | 用途 |
|---|---|
| `POST /api/offline/evaluate` | **最快上手**：贴 JD + 问答，直接返回报告 |
| `POST /api/jobs` · `POST /api/candidates` · `POST /api/interviews` | 建岗位 / 候选人 / 面试 |
| `POST /api/documents/parse` | 解析简历 / JD（文本、PDF、Word、图片） |
| `POST /api/probe` | 生成深挖追问 |
| `POST /api/aigc/detect` | AIGC 作弊检测 |
| `POST /api/scoring/score` | 结构化评分 |
| `POST /api/report/build` | 构建报告 |
| `POST /api/interviews/{id}/end` | 结束面试并触发离线评分 |
| `GET /api/interviews/{id}/report[.html\|.json\|.pdf]` | 获取报告各格式 |
| `WS /ws/interview/{id}` | 实时面试 WebSocket |
| `GET /api/config/status` · `GET /metrics` | 配置自检（不泄密）· Prometheus 指标 |

离线评估示例：

```bash
curl -s http://127.0.0.1:9958/api/offline/evaluate \
  -H 'content-type: application/json' \
  -d '{
    "job_title": "AI 后端工程师",
    "jd_text": "Python FastAPI LLM 可靠性",
    "candidate_name": "候选人A",
    "turns": [
      {"question": "介绍一个核心项目",
       "answer": "我主要负责整体架构设计并推动项目落地最终取得显著提升",
       "answer_start_ms": 0, "answer_end_ms": 1000}
    ]
  }'
```

---

## 测试与校准

```bash
pytest -q                                    # 全量测试（约 35s）
python -m scripts.eval_scoring               # 6 画像评分实证，看分数校准
pytest tests/test_scoring_calibration.py     # 评分校准回归（锁定反作弊判据）
```

> 测试用 `tests/conftest.py` 强制 mock 模式，**绝不调用真实大模型**，全量跑完只需几十秒。

---

## 安全与隐私

- **不要提交 API key**。密钥只写在本机私有存储（设置页保存，文件权限 0600）或 `.env`；`/api/config/status` 与模型接入列表只返回"是否已配置"，数据库 URL 隐去密码。
- 部署时设 `GATEWAY_API_KEY`，要求 `/api/*` 与 WebSocket 携带 `X-API-Key` 或 `Authorization: Bearer`；网页端在顶部填入后只存于当前浏览器会话。
- **行为信号默认关闭**，需管理员开 `SIGNAL_ENABLED=true` **且**候选人通过 `POST /api/consents` 授权后才采集；撤回授权即停止。
- 本地说话人归属只信任显式角色 / channel 映射，不做音频指纹猜测。

---

## 许可

本项目用于面试辅助与候选人评估研究。请在合规、知情同意的前提下使用，遵守当地关于录音与个人信息处理的法律法规。
