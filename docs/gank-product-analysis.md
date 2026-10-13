# Gank Interview v2.4.0 逆向学习分析报告

> 目标：向 Gank Interview（AI面试助手）学习产品力，找出「左右」可优化的方向。
> 分析来源：解包的 Gank Interview v2.4.0 应用（`/tmp/gank_extract/app.asar`）+ 新手引导页 `gank_getstarted.html` + 字符串表。

## 一、Gank 的产品定位

Gank Interview 定位为 **AI 面试助手**（AI Interview Copilot），覆盖完整求职场景：

- AI 模拟面试（AI Mock Interview）
- AI 笔试（coding test / written test）
- 简历优化（Resume Optimizer）
- 题库（Question Bank）
- 求职资源（Job Resources）
- 自测工具（Self-Test Tools）
- 校招/实习/国企信息表（Campus / Internship / State-Owned Table）
- 投递进度跟踪（Application Progress）

**核心洞察**：Gank 是一个**闭环的求职工具链**，而「左右」目前只聚焦「截图问 AI」单一环节。这是产品定位上的差距——但从「学习产品力」角度，我们更应关注**交互体验和系统能力**，而非盲目扩场景。

## 二、Gank 可学习的 5 个产品力点

### 1. Stealth 低调模式 ⭐ 高价值
Gank 提供「低调版」：
- 无 logo 图标
- 使用系统化的进程名（Task Manager 里看起来像系统进程）
- 更适合面试场景的低调使用

**左右可学**：面试助手场景下，低调/隐藏存在感是真实需求。可提供「低调模式」开关：隐藏 Dock 图标、托盘图标替换为无辨识度样式、窗口标题通用化。

### 2. 知识库（KnowledgeBase）⭐ 高价值
Gank 有本地知识库：
- 可导出/导入 `.gankkb` 文件
- 自动保存知识块（Chunk）并生成摘要
- `[KnowledgeBase] Saved chunk` / `[KnowledgeBase] Chunk summary`

**左右可学**：答题过程中的题目/解答/知识点可自动沉淀为可检索的知识库，支持导出分享。这能让「左右」从「一次性答题」进化为「累积学习资产」。

### 3. 考试/会话记录 ⭐ 高价值
Gank 记录考试会话：
- `ExamRecord` / `mainScreenshots` / `screenshotCount`
- 保存带截图的完整考试记录
- 支持导出、重看

**左右可学**：每次刷题会话（截图+提问+回答）可保存为结构化记录，支持回看和导出。当前「左右」的新对话会清空历史（`history.length = 0`），缺少持久化记录。

### 4. 平台兼容性检查器
Gank 提供平台兼容性检查：
- 让用户选择将使用的面试平台（Chrome、Edge、Nowcoder、CoderPad、HackerRank、Feishu、DingTalk、Google Meet、Tencent Meeting、Zoom）
- 展示各平台支持状态
- 对部分平台提供「引导式设置」以获得更稳定的低调显示

**左右可学**：面试助手的核心价值在于**不被发现**。提前让用户确认目标平台、并针对平台给出显示/隐藏优化建议，是重要的信任建立和防翻车机制。

### 5. 权限引导（已实现，可作为对照）
Gank 的权限引导：
- Mac：System Settings -> Privacy & Security -> **Screen & System Audio Recording** + **Microphone**
- Windows：通常无需额外授权，部分需「以管理员身份运行」
- 授予后需重启应用

**左右已实现**：权限菜单 + 系统设置深度链接 + 聚焦自动重检。Gank 多覆盖了 **System Audio（系统音频）** 和 **Microphone**——左右当前主要处理屏幕录制，可评估是否补麦克风/系统音频权限引导。

## 三、推荐落地优先级

| 优先级 | 功能 | 理由 | 实现成本 |
|--------|------|------|----------|
| P1 | **Stealth 低调模式** | 面试场景刚需，改动集中（主进程+托盘） | 低 |
| P2 | **考试/会话记录** | 提升长期价值，改动集中（渲染层+本地存储） | 中 |
| P3 | **知识库** | 从工具进化为学习资产，需新增存储与检索 | 中高 |
| P4 | **平台兼容性检查器** | 提升信任，主要是引导页 + 平台映射表 | 低 |

## 四、Gank 新手引导流程（参考模板）

Gank 的 getstarted 页是清晰的 4 步引导：

1. **下载** → 按平台下载安装包（Mac/Windows），提供普通版 + 低调版
2. **安装并授权** → 明确列出需要授予的系统权限及路径
3. **检查平台兼容性** → 选择面试平台，确认支持状态
4. **记住快捷键** → 展示核心快捷键（显示/隐藏、截图、移动窗口、生成答案、重置、退出）

> 「左右」可将此作为**首次启动引导页**的参考结构。

---

*本报告基于对 Gank Interview v2.4.0 解包应用的逆向分析，用于「左右」产品的体验优化参考。*
