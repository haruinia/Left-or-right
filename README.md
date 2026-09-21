# 六娃

隐身截屏对话。截当前屏幕，发给设置里的大模型，首页流式显示。原来的面试工作台在 `/settings`。

本仓库按 `/Users/zhangyifan/Downloads/水货杀手_工程规格.md` 实现，是一个本地优先的 Python MVP：

- 使用 Python 3.11+ 和 Pydantic v2 定义跨服务数据契约。
- 基于 FastAPI 实现服务和 API 网关。
- 本地默认使用 SQLite 持久化，部署 profile 支持 PostgreSQL 运行时适配。
- 本地开发使用内存异步事件，并显式发布离线评分事件。
- 离线评分有本地任务队列边界，并可选发布到 Redis Streams。
- 面试状态机拒绝报告后的修改，也拒绝面试未结束就进入评分。
- 离线评分拒绝空候选人问答上下文，避免生成无依据报告。
- 统一 LLM client，支持 mock 模式和 OpenAI 兼容 HTTP 模式，默认模型名为 `mimo-v2.5-pro`。
- 运行时 LLM prompt 放在 `prompts/` 下，由服务加载，不硬编码在业务代码中。
- 追问响应在 schema 层限制为 1 到 3 条建议，符合实时追问卡契约。
- 追问请求会在构建 prompt 前拒绝重复的 recent turn id。
- LLM 生成的追问卡会按优先级排序并重新编号后再返回实时客户端。
- ASR 接口支持本地 stub 模式和可配置 HTTP 云 ASR 适配器。
- ASR 会话会去重重复 final chunk，支持 partial 到 final 更新，使用显式 speaker/channel 归属，并仅对短间隔 unknown speaker 做保守连续性平滑。
- 转写片段进入编排前会拒绝空 session id 或空文本。
- 支持从 JD 和面试问答到追问、评分、AIGC 检测、报告的端到端离线 demo。
- 本地 demo UI 同时包含离线评估和实时 WebSocket 追问面板。
- 实时 WebSocket 面板支持浏览器麦克风采集，并以 16k PCM `audio_chunk` 发送给后端 ASR。
- 面试问答会同时写入 interview context 和 `qa_turns` 审计表。
- 面试问答、评分证据摘录等共享 schema 边界会拒绝空文本。
- AI 追问生成的问答必须带非空 `probe_target`，保证报告 transcript 保留追问目的。
- 岗位、候选人、胜任力维度、追问卡等契约字段都会拒绝空的必填文本。
- WebSocket transcript 携带 speaker、finality、timestamp 元数据，支持手动角色、双设备角色链接和 channel 映射，并单独发送可信度事件。
- Docker Compose 声明 gateway、PostgreSQL、Redis 和 MinIO 本地基础设施。
- PostgreSQL core schema SQL 位于 `db/postgres`，用于 compose 初始化。
- 运行时数据库 URL 解析支持 SQLite 和 PostgreSQL。
- 创建面试和同意记录时会校验候选人引用，使本地 SQLite 行为与 PostgreSQL 外键契约一致。
- JD 知识库会为各胜任力维度的追问范式建立确定性 embedding，并支持可选 pgvector 检索。
- 追问范式检索分数拒绝 infinite 值，确保排序可复现。
- JD 胜任力模型通过共享 LLM JSON client 生成，并带确定性 fallback；输出会归一化，确保必需评分维度和权重存在。
- 胜任力模型拒绝重复维度名，避免追问、评分和报告匹配产生歧义。
- 胜任力权重和评分权重拒绝 NaN/inf，保证 Python 侧加权总分可复现。
- 报告产物默认写本地文件，配置对象存储后上传到 S3 兼容存储。
- 报告包含结构化评分、雷达图、亮点、AIGC 检查、一致性标记、去重风险高亮、建议和完整 transcript。
- 报告构建会拒绝 score session 不匹配、维度名/权重不匹配、总分不匹配、建议不匹配、证据 turn id 异常、证据时间越界、证据摘录不在 transcript 中、重复证据引用、未知一致性标记 turn id、AIGC 覆盖缺失/重复、未知 AIGC turn id，以及超过阈值但未 flagged 的 AIGC 结果。
- 报告生成会分别写出结构化 JSON、HTML、PDF 和 transcript JSON，便于审计和存储。
- 报告 artifact path 和 URI 在共享输出边界拒绝空值。
- 报告输出记录会拒绝与嵌入 score session 不一致的 interview id。
- 报告输出记录要求 transcript 非空，并拒绝 transcript 外的 evidence、AIGC 或 consistency 引用。
- PDF 生成优先使用 WeasyPrint；缺少原生渲染依赖时，回退为可审计文本 PDF，包含分数、建议、证据、风险、AIGC 和 transcript 摘要，并支持中文文本。
- Interview context 保留可审计事实表，记录角色、职责、技术和指标陈述，供一致性检查使用，包括共享上下文中的指标冲突。
- Interview context 会拒绝引用当前 transcript 外 turn 的 fact claim 或 consistency flag。
- Fact claim 的职责、技术和指标条目会在一致性检查前拒绝空文本。
- Consistency flag 必须引用两个不同 transcript turn，保证风险高亮可追溯。
- 评分使用共享 LLM JSON client 生成结构化维度草稿，并在 Python 中重新计算总分，保证可审计；即使 LLM 草稿给出更高分，确定性风险信号仍会封顶相关维度，且确定性风险备注会保留到报告中。
- 评分证据会归一化到真实 transcript span，并在报告前去重。
- 评分和报告请求 envelope 会在业务逻辑执行前拒绝缺失、重复或未知的 AIGC turn 覆盖。
- Interview score 在总分或报告接受前拒绝重复维度名。
- 评分风险备注在共享 schema 边界拒绝空条目。
- 评分 schema 要求每个维度至少有一条 evidence reference。
- AIGC 检查结合本地回答模板语料和可选 HTTP detector。
- AIGC 检测请求在评分/报告前拒绝空 turn batch 和重复 turn id。
- 记录 AIGC 模板命中时，matched template 名称拒绝空文本。
- 离线评估输入在构建本地 demo 链路前拒绝重复 turn id。
- 面试 turn 写入拒绝重复 turn id，保证 evidence、AIGC 和 report 引用不歧义。
- Job 和 interview 记录会拒绝与父记录不匹配的嵌套 context 或 competency-model 标识符，包括 interview session id。

## 密钥处理

不要提交 API key。请放到 `.env` 或当前 shell：

```bash
export LLM_PROVIDER=openai_compatible
export LLM_MODEL=mimo-v2.5-pro
export LLM_BASE_URL="https://token-plan-cn.xiaomimimo.com/v1"
export LLM_API_PATH="/chat/completions"
export LLM_API_KEY="your-key"
export LLM_AUTH_HEADER="api-key"
export LLM_AUTH_SCHEME=""
export LLM_RESPONSE_CONTENT_PATH="choices.0.message.content"
export LLM_EXTRA_BODY_JSON=""
export LLM_MAX_RETRIES=1
export LLM_RATE_LIMIT_ENABLED=false
export LLM_RATE_LIMIT_REQUESTS_PER_MINUTE=60
```

如果 `LLM_PROVIDER=mock`，或没有配置 API key，系统会使用确定性的本地 mock 输出。

`LLM_EXTRA_BODY_JSON` 只能填写 JSON object，例如 `{"enable_thinking":false}`；无效 JSON 或数组/字符串会在启动配置校验阶段被拒绝。

`LLM_RESPONSE_CONTENT_PATH` 必须是非空点分路径，例如 `choices.0.message.content` 或 `data.output`；空值或 `choices..content` 这类空段会在启动配置校验阶段被拒绝。

ASR、speaker diarization 和 AIGC detector 的响应字段映射 path 同样必须是非空点分路径，例如 `text`、`payload.result` 或 `data.ai_generated_prob`。

配置真实 API key 时，对应的 auth header 不能为空，例如 `LLM_AUTH_HEADER`、`ASR_AUTH_HEADER`、`SPEAKER_DIARIZATION_AUTH_HEADER` 或 `AIGC_DETECTOR_AUTH_HEADER`。

默认值遵循 MiMo OpenAI 兼容 chat completions 协议。如果供应商变更 endpoint、鉴权 header、响应 JSON 结构或重试策略，只需要修改上面的 `LLM_*` 环境变量。LLM JSON 解析会经过 Pydantic 校验；HTTP、JSON 或 schema 失败时默认重试一次，然后回退到确定性本地行为。配置的响应路径可以解析到 JSON 字符串，也可以解析到已经解码的 JSON 对象。

设置 `LLM_RATE_LIMIT_ENABLED=true` 可以在请求离开进程前按模型限流；限流调用默认本地 fallback，除非诊断代码明确要求 `raise_on_error`。

DeepSeek v4 pro 可直接使用同一套 OpenAI-compatible 配置：

```bash
export LLM_PROVIDER=openai_compatible
export LLM_MODEL=deepseek-v4-pro
export LLM_BASE_URL="https://api.deepseek.com"
export LLM_API_PATH="/chat/completions"
export LLM_API_KEY="your-deepseek-key"
export LLM_AUTH_HEADER="Authorization"
export LLM_AUTH_SCHEME="Bearer"
export LLM_RESPONSE_CONTENT_PATH="choices.0.message.content"
```

配置后运行 `python scripts/check_llm.py`。看到 `LLM smoke test ok.` 表示真实大模型链路已经接通；如果输出 `LLM mock mode ok. No real model endpoint was called.`，说明当前仍在本地 mock 模式，没有调用真实模型 endpoint。

部署环境建议设置 `GATEWAY_API_KEY`，要求 `/api/*` 和 WebSocket 流量携带 `X-API-Key: ...` 或 `Authorization: Bearer ...`。本地 demo 默认不启用。

## 本地运行

本地单进程开发建议使用 `8001`，避免和 Docker Compose 默认映射的 `8000` 混用。如果你的机器上 `8001` 也被占用，可以把下面命令和访问地址中的端口替换为其他空闲端口。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python scripts/run_offline_demo.py
python scripts/run_gateway.py
```

启动脚本会先打印本地访问地址、API 文档地址、模型 provider/model、ASR provider 和数据库地址摘要；摘要只显示是否已配置，不会输出 API key、token 或密码。如果本机 `8000` 空闲，脚本会同时把 `http://127.0.0.1:8000/` 重定向到当前本地 gateway 地址；如果 `8000` 已被 Docker 或其他服务占用，脚本会提示你打开当前脚本实际启动的地址，避免误开 `8000`。如需关闭这个重定向，加 `--no-default-port-redirect`。

API 文档地址：`http://127.0.0.1:8001/docs`。

本地 demo UI 地址：`http://127.0.0.1:8001/`（六娃首页）。设置与面试工作台：`http://127.0.0.1:8001/settings`。

如果端口被占用，脚本会直接提示；也可以手动指定端口：

```bash
python scripts/run_gateway.py --port 8002
```

## 使用 Docker Compose 运行

Docker Compose 会启动工程规格中要求的 gateway、PostgreSQL、Redis 和 S3 兼容 MinIO。

```bash
docker compose up --build
```

Docker Compose 默认把 gateway 暴露到 `http://127.0.0.1:8000/`。如果 `8000` 已被占用，使用 `GATEWAY_PORT=18000 docker compose up --build`，再访问 `http://127.0.0.1:18000/`。

如果本地端口已被占用，可以覆盖宿主机端口绑定，不影响容器间地址：

```bash
GATEWAY_PORT=18000 POSTGRES_PORT=15432 REDIS_PORT=16379 MINIO_PORT=19000 MINIO_CONSOLE_PORT=19001 docker compose up --build
```

如果要在同一个 compose stack 中运行可选 Celery 离线评分 worker：

```bash
OFFLINE_TASK_BACKEND=celery OFFLINE_TASK_EXECUTION=async docker compose --profile worker up --build
```

compose gateway 默认通过 `postgresql://shuihuo:shuihuo_local@postgres:5432/shuihuo_killer` 使用 PostgreSQL；非 Docker 本地 profile 仍默认使用 SQLite，方便快速 demo。

compose stack 会把 `.env.example` 中的运行时集成参数传入对应服务，包括 gateway 鉴权、LLM 重试/限流、ASR 响应映射、probe 触发阈值、外部 AIGC detector 设置、Redis rate-limit 设置，以及 Celery worker 的 AIGC/LLM 设置。

PostgreSQL 从 `db/postgres/001_core_schema.sql` 初始化。该 schema 声明规格中的 jobs、candidates、interviews、turns、probe-pattern embeddings、scores、AIGC results、reports 和 consent 表，并对面试状态、turn 时间戳、question source、score 范围、AIGC 概率/相似度、recommendation 和行为信号 consent type 建立 CHECK 约束。

interview status 必须与 `started_at`/`ended_at` 匹配；该规则同时存在于共享模型、PostgreSQL core schema 和新初始化的本地 SQLite schema 中。SQLite interview rows 将 `signal_enabled` 保存为 0/1 boolean。新 SQLite `qa_turns` 表也会执行与 PostgreSQL 审计表一致的 turn index、source、文本、时间范围和 probe target 检查。SQLite `aigc_results`、`scores`、job、candidate、probe-pattern、consent、report 和 JSON-backed 列也有对应边界校验。运行时 adapter 会把本仓库的参数风格和 upsert 语法转换为 PostgreSQL 可执行形式。

默认 compose stack 只挂载 core schema，确保 Docker 官方 PostgreSQL 镜像可以直接运行。对于已安装 pgvector 的 PostgreSQL 部署，可设置 `JD_VECTOR_BACKEND=pgvector`，应用启动时会应用 `db/postgres/002_pgvector_probe_patterns.sql`，并使用 `embedding_vector <=> query` 做追问范式最近邻检索。

设置 `OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_BUCKET`、`OBJECT_STORAGE_ACCESS_KEY` 和 `OBJECT_STORAGE_SECRET_KEY` 后，报告 HTML/PDF artifact 会上传到 MinIO 等 S3 兼容存储。Transcript JSON artifact 也使用同一个 store。开发和审计仍会先保留本地副本。

运维端点：

```bash
curl -s http://127.0.0.1:8001/metrics
RATE_LIMIT_ENABLED=true RATE_LIMIT_REQUESTS_PER_MINUTE=120 uvicorn services.gateway.app:app --port 8001
```

设置 `RATE_LIMIT_BACKEND=redis` 并安装 `.[redis]` 后，可以通过 Redis 在多个进程间共享 gateway rate-limit 计数器。本地开发默认使用内存 backend。

HTTP 响应包含 `X-Request-ID` 和 W3C `traceparent`；客户端也可以传入这些 header，用于关联 API 调用、structlog JSON 日志和 Prometheus 请求指标。部署到 OpenTelemetry collector 后，可设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 并安装 `.[otel]` extra；Docker 镜像已经包含该 extra，并会在 endpoint 配置后自动 instrument FastAPI gateway。`/metrics` 还暴露离线评分路径中的领域/任务事件计数，例如 `task.enqueued`、`task.completed`、`task.failed`、`task.worker_failed`、`interview.finished` 和 `interview.reported`。

检查运行时配置且不泄露密钥：

```bash
python scripts/check_llm.py
python scripts/diagnose_llm_network.py
LLM_API_KEY=your-key python scripts/diagnose_llm_auth.py
curl -s http://127.0.0.1:8001/api/config/status
```

`check_llm.py` 在 `LLM_PROVIDER=mock` 时只验证本地 fallback 链路，会输出 `LLM mock mode ok. No real model endpoint was called.`；只有 `LLM_PROVIDER=openai_compatible` 且 key/base URL 配好后，`LLM smoke test ok.` 才代表真实模型调用成功。

`/api/config/status` 只返回非密钥 provider path、响应映射 path、timeout、OTLP exporter 是否存在，以及密钥是否已配置；不会返回 API key。数据库 URL 会隐藏密码。Provider/backend selector、数字阈值和必要 companion URL 会在 settings 加载时校验，配置不支持或不完整时会在启动或 smoke test 阶段尽早失败。

设置 `GATEWAY_API_KEY` 后，请在 API 请求中加入 `X-API-Key` 或 bearer token。WebSocket 客户端可以通过 header 或 `?api_key=...` 传入同一 key。使用本地 demo UI 时，在页面顶部 `Gateway Key` 输入框填入同一 key 并点击“保存 Key”；该 key 只保存在当前浏览器会话中，页面会自动带到 API 和报告下载请求，WebSocket 会通过 `gateway-key.*` subprotocol 携带 key，避免把 key 写进 URL。

如果 `check_llm.py` 报连接错误，运行 `diagnose_llm_network.py`。它会检查配置的 `LLM_BASE_URL` 的 DNS、TCP 和 TLS，不会打印 API key。

对于默认 MiMo endpoint，`diagnose_llm_network.py` 应先报告 DNS、TCP、TLS 均 OK，再排查 API key 或请求格式问题。如果 `check_llm.py` 返回 `HTTP 401 Invalid API Key`，运行 `diagnose_llm_auth.py` 试探常见 OpenAI 兼容鉴权 header 变体。如果所有变体都返回 401，请重新生成 key，并通过 `LLM_API_KEY` 设置，不要提交到仓库。

## 主要 API

- `POST /api/jobs`
- `POST /api/documents/parse?kind=resume|jd&filename=...`
- `POST /api/candidates`
- `POST /api/consents`
- `POST /api/interviews`
- `POST /api/probe`
- `POST /api/aigc/detect`
- `POST /api/scoring/score`
- `POST /api/report/build`
- `POST /api/offline/evaluate`
- `GET /api/config/status`
- `GET /metrics`
- `GET /api/jobs/{id}/probe-patterns?q=...`
- `POST /api/interviews/{id}/end`
- `GET /api/interviews/{id}/report`
- `GET /api/interviews/{id}/report.html`
- `GET /api/interviews/{id}/report.json`
- `GET /api/interviews/{id}/report.pdf`
- `GET /api/interviews/{id}/report.transcript.json`
- `WS /ws/interview/{id}`

WebSocket `audio_chunk` 事件可以包含 `speaker`、`channel`/`audio_channel`/`track`、`is_final`、`start_ms`、`end_ms` 和 `confidence`。默认 `SPEAKER_MODE=manual`，网页会通过“面试官发言 / 候选人发言”按钮把当前角色作为 `speaker` 和 `channel` 上报；双设备链接会带 `?role=interviewer` 或 `?role=candidate`，各自默认发送对应角色。双设备连接共享同一套对话装配状态，但 ASR 序号和云端流按设备隔离，因此两端都从 `seq=1` 开始也不会互相去重，面试官设备的问题可以与候选人设备的回答自动配对。若省略 `speaker`，列在 `ASR_INTERVIEWER_CHANNELS` 中的 channel 会映射为 `interviewer`，列在 `ASR_CANDIDATE_CHANNELS` 中的 channel 会映射为 `candidate`。所有 final segment 都会进入对话装配层；候选人完整回答会无条件入库，追问触发单独由 credibility/覆盖缺口判断。下行事件包括句子级 `transcript`、装配完成的 `turn`、`probe_chains`、`probe`、`probe_update`、`credibility`、可选 `signal`、`report`，以及 async 模式下的 `task_queued`。

网页实时面板的“开始麦克风”按钮会请求浏览器麦克风权限，把当前角色语音降采样为 16k 单声道 PCM16，并通过同一个 `audio_chunk` 协议发送。默认 `ASR_PROVIDER=stub` 只能验证链路；要获得真实转写，可配置 `ASR_PROVIDER=http` 对接普通 HTTP ASR endpoint，配置 `ASR_PROVIDER=aliyun_ws` 对接阿里云 DashScope Paraformer 实时 WebSocket ASR，或配置 `ASR_PROVIDER=aliyun_nls_ws` 对接阿里云智能语音交互 NLS WebSocket ASR。

资料区的 JD 和简历上传支持纯文本、Markdown、JSON、CSV、LOG、PDF、Word `.docx`/`.doc` 和常见图片格式，单个文件最大 25MB。文件名缺少扩展名时，后端也会接受常见的 `text/*`、`image/*`、`application/pdf`、Word MIME type。后端会先抽取文本；如果当前 `LLM_PROVIDER=openai_compatible` 且配置了 DeepSeek v4 pro API key，会再调用 DeepSeek 对抽取内容做去噪和正文提取。图片版简历依赖 OCR：macOS 本地运行 `pip install -e '.[ocr]'` 安装 `ocrmac`，否则接口会返回明确的 OCR 依赖错误。

同一 seq 的重复 final ASR chunk 会去重，并返回 `asr_warning`，不会重复生成追问。ASR 返回 `unknown` speaker 时，本地模式不会做声纹或音频哈希匹配，只会在很短间隔内沿用上一位已知说话人；生产环境需要配置 HTTP diarization provider 才会尝试真实说话人分离。`audio_chunk` 如果包含 `session_id`，必须与 WebSocket interview id 一致；不一致时返回 `asr_warning` 并跳过。

无效或空的 `audio_chunk.audio` 会返回 `asr_warning`，不会转换成占位 transcript。空白 `text_turn.answer` 会返回 `error`。二进制帧、无效 JSON 文本帧和非 object 的 WebSocket JSON payload 会返回 `error`，但保持会话打开。过早的 `end` 如果不满足状态守卫，也返回 `error` 且不关闭会话。提供音频元数据时，gateway 只接受 PCM/Opus 风格格式、`sample_rate_hz=16000` 和 `channels=1`；不支持的值会在进入 ASR 前被拒绝。

通过 `PROBE_MIN_ANSWER_CHARS` 和 `PROBE_MIN_INTERVAL_MS` 控制完整候选人回答何时有资格触发自动追问。触发方向由本地 credibility 评估和能力覆盖缺口决定：逃避、含糊回答会触发追问，solid 回答在能力维度覆盖不足时继续追问。`PROBE_REQUIRE_TOPIC_MATCH` 和 `PROBE_TOPIC_KEYWORDS` 仍保留为兼容旧部署脚本的废弃变量，但不再参与追问判断。发送 WebSocket `manual_probe` 事件并带 `answer`，可模拟面试官点击“立即追问”；manual probe 会绕过自动长度和间隔 gate。

v2 对话与风险阈值通过 `DIALOGUE_SILENCE_CLOSE_MS=2500`、`REHEARSAL_THRESHOLD=0.55`、`CHAIN_CRACK_PENALTY=8` 和 `CHAIN_HELD_UP_BONUS=3` 配置。语音模式报告展示“背稿与模板化检测”，不展示面向异步文字场景的 AI 代答概率；LLM 不可用时，HTML、PDF 和网页报告都会标明确定性规则降级模式。

设置 `ASR_PROVIDER=http`、`ASR_BASE_URL`、`ASR_API_PATH` 和 `ASR_API_KEY` 后，音频 chunk 会转发给云 ASR endpoint。响应映射可通过 `ASR_TEXT_PATH`、`ASR_SPEAKER_PATH`、`ASR_START_MS_PATH`、`ASR_END_MS_PATH`、`ASR_IS_FINAL_PATH` 和 `ASR_CONFIDENCE_PATH` 配置。`partial`、`interim`、`provisional` 等 finality 字符串会被视为非 final，避免临时 ASR 输出触发追问。ASR 时间戳会归一化为非负毫秒区间，并满足 `end_ms >= start_ms`；共享 transcript、Q&A 和 scoring evidence schema 也会在 API 边界拒绝非法时间区间。Interview context 和 record 也拒绝早于 `started_at` 的 `ended_at`。

设置 `ASR_PROVIDER=aliyun_ws` 和 `ALIYUN_ASR_API_KEY` 后，gateway 会为每个接入设备建立独立的阿里云 DashScope Paraformer 实时 ASR WebSocket 流，并在同一面试会话内汇总转写。浏览器音频帧会以二进制 PCM 持续发送，阿里云 `result-generated` 事件会异步转换为 `transcript` 下行事件。默认模型为 `ALIYUN_ASR_MODEL=paraformer-realtime-v2`，endpoint 为 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`。Paraformer 实时接口不返回说话人分离结果，因此演示环境应使用手动角色按钮或双设备角色链接；若 `speaker=unknown`，本地只做短间隔连续性平滑，不做假声纹。真实 key 冒烟检查：

`ALIYUN_ASR_API_KEY` 必须是百炼/DashScope API Key，不是智能语音交互 NLS 的 AppKey。NLS AppKey 单独不能用于当前 DashScope WebSocket Bearer 鉴权。

```bash
ALIYUN_ASR_API_KEY=your-dashscope-key python scripts/check_aliyun_asr.py
```

脚本默认发送 `tests/fixtures/sample_16k_mono.pcm`；也可以用 `--pcm-path` 指向自己的 16k 单声道 PCM16 语音文件。若阿里云会话完成但没有返回任何转写文本，脚本会返回失败。只有显式传入 `--allow-empty-result` 时，空转写才会按成功退出；此时脚本会输出 `session completed, but no transcript text was verified`，表示只验证了 WebSocket 会话完成，没有验证识别文本有效。

如果只有智能语音交互 NLS 的 AppKey，可以改用 `ASR_PROVIDER=aliyun_nls_ws`。该模式支持两种鉴权方式：直接配置临时 Token，或配置阿里云 AccessKey 让 gateway/smoke 脚本自动创建 NLS Token。

```bash
ASR_PROVIDER=aliyun_nls_ws
ALIYUN_NLS_APP_KEY=your-nls-appkey
ALIYUN_NLS_TOKEN=your-nls-token
```

NLS AppKey 用于 StartTranscription payload，NLS Token 用于 WebSocket URL 鉴权；只配置 AppKey 不能连接。固定 Token 优先级最高；如果 `ALIYUN_NLS_TOKEN` 为空，但 `ALIYUN_AK_ID` 和 `ALIYUN_AK_SECRET` 已配置，gateway 会在连接 NLS WebSocket 前自动创建 Token，并复用未过期 Token。

```bash
ALIYUN_NLS_APP_KEY=your-nls-appkey ALIYUN_NLS_TOKEN=your-nls-token python scripts/check_aliyun_nls_asr.py
```

如果没有现成 Token，但有阿里云 AccessKey，可以先生成 Token，或让 gateway/smoke 脚本自动生成：

```bash
ALIYUN_AK_ID=your-access-key-id ALIYUN_AK_SECRET=your-access-key-secret python scripts/create_aliyun_nls_token.py
ALIYUN_NLS_APP_KEY=your-nls-appkey ALIYUN_AK_ID=your-access-key-id ALIYUN_AK_SECRET=your-access-key-secret python scripts/check_aliyun_nls_asr.py
```

脚本默认同样发送 `tests/fixtures/sample_16k_mono.pcm`；如果会话完成但没有返回任何转写文本，脚本会返回失败。只有显式传入 `--allow-empty-result` 时，空转写才会按成功退出；此时脚本会输出 `session completed, but no transcript text was verified`，表示只验证了 WebSocket 会话完成，没有验证识别文本有效。

如果 ASR provider 对某一帧失败或返回非法 transcript，WebSocket 会发送 `asr_warning`，`reason=asr_transcription_failed`，并保持面试会话打开，后续帧仍可继续处理。

设置 `SPEAKER_DIARIZATION_PROVIDER=http`、`SPEAKER_DIARIZATION_BASE_URL`、`SPEAKER_DIARIZATION_API_PATH` 和 `SPEAKER_DIARIZATION_API_KEY` 后，可通过生产声纹聚类服务解析 unknown speaker。响应 speaker path 默认是 `SPEAKER_DIARIZATION_SPEAKER_PATH=speaker`。Docker Compose 会把同一组 `SPEAKER_DIARIZATION_*` 变量传给 gateway，并在启动时用运行时 settings 刷新 ASR session diarizer。

设置 `AIGC_DETECTOR_PROVIDER=http`、`AIGC_DETECTOR_BASE_URL`、`AIGC_DETECTOR_API_PATH` 和 `AIGC_DETECTOR_API_KEY` 后，每条回答会发送到外部 AI 文本 detector。本地模板相似度结果和配置的概率阈值仍会参与最终 flag 决策；HTTP 失败会回退到确定性本地 detector。

## 一次性离线评估

第一个 demo 路径建议使用该 endpoint：粘贴 JD 和面试问答，返回结构化报告以及生成的 HTML/PDF 路径。

本地 profile 下，`POST /api/interviews/{id}/end` 会发布任务事件，并同步运行离线 pipeline，所以 demo 仍会立即返回报告。持久化的面试状态仍遵循规格流转：第一条 turn 写入会启动 created interview，然后 end 触发 `IN_PROGRESS -> FINISHED -> SCORING -> REPORTED`。

离线评分任务默认使用 `OFFLINE_TASK_BACKEND=local`。设置 `OFFLINE_TASK_BACKEND=redis_stream` 并安装 `.[redis]` 后，也会把任务 payload 发布到 Redis Streams，stream 名为 `{REDIS_STREAM_PREFIX}:tasks:{task_name}`，同时保留同步本地执行。设置 `OFFLINE_TASK_BACKEND=celery` 并安装 `.[celery]` 后，会通过 Celery 发布同一个 `interview.offline_scoring` 任务，使用 `CELERY_BROKER_URL` 和 `CELERY_RESULT_BACKEND`。publisher 和 worker 都使用 `CELERY_TASK_QUEUE`，默认值为 `shuihuo-offline`，自定义部署必须两侧一致。

设置 `OFFLINE_TASK_EXECUTION=async` 后，`POST /api/interviews/{id}/end` 会返回 queued task，而不是阻塞等待报告。任务入队后，interview 会推进到 `SCORING`，重复 end 请求无法再次入队。worker 消费 Redis Stream 后生成报告。`POST /api/offline/evaluate` 为 demo 和 smoke test 保持同步执行。

运行 Redis Streams 离线评分 worker：

```bash
OFFLINE_TASK_BACKEND=redis_stream python scripts/run_offline_worker.py
```

部署 smoke test 可以使用 `--once` 只轮询一次。Redis Streams worker 遇到 handler error 或 malformed payload 时，会发送 `task.worker_failed`，并保留失败消息未 ack，便于重试或人工检查。

运行 Celery worker：

```bash
OFFLINE_TASK_BACKEND=celery celery -A services.offline_worker.celery_tasks:celery_app worker --loglevel=info
```

示例请求：

```bash
curl -s http://127.0.0.1:8001/api/offline/evaluate \
  -H 'content-type: application/json' \
  -d '{
    "job_title": "AI 后端工程师",
    "jd_text": "Python FastAPI LLM 可靠性",
    "candidate_name": "候选人A",
    "turns": [
      {
        "question": "介绍一个核心项目",
        "answer": "我主要负责整体架构设计并推动项目落地最终取得显著提升",
        "answer_start_ms": 0,
        "answer_end_ms": 1000
      }
    ]
  }'
```

## 范围说明

实时 ASR 和可选行为信号模块都通过接口实现，并带本地 stub engine。生产说话人聚类服务可以通过 HTTP diarization provider 接入，不需要修改共享 schema；本地 provider 只信任显式 `speaker` 或 channel 映射，不做音频簇/声纹匹配。

行为信号默认关闭。必须由管理员设置 `SIGNAL_ENABLED=true`，面试才能请求 `signal_enabled=true`；候选人还必须通过 `POST /api/consents` 授权 `behavior_signal`，否则 API 返回 403。用同一 consent endpoint 发送 `granted=false` 会撤销之前的有效行为信号同意；之后的 signal-enabled interview 会被拒绝，直到管理员开关和候选人授权两个 gate 都满足。Consent 检查使用数据库参数化 boolean，使同一流程在 SQLite 和 PostgreSQL 上都可运行。共享 consent record 也会在持久化前拒绝早于授权时间的 revoked timestamp。实时 WebSocket 路径在发送每个可选 `signal` 事件前也会重新检查有效 consent，因此撤销同意后会停止输出行为信号提示。
