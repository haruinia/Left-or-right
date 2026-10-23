# 返回、切题与翻页体验复核

日期：2026-10-22（America/Los_Angeles）。用户要求先保存 Git，再针对实际使用体感继续对比。修改前检查点为 `885638d`；本轮修复已构建并覆盖安装到 `/Applications/左右.app`。

## 找到的问题与修复

| 场景 | 修改前的实测 | 修改后与处理 |
| --- | --- | --- |
| 长回答返回 | 515px 正文中 scrollTop=1140，直接落到结尾 | 从开头显示，scrollTop=0；新题归零是左右的明确阅读策略，并非已证实的 Gank 重置 effect |
| 第二题返回 | 旧长答案仍撑高外层；第二题正文仅剩 28px | 主面板只展示当前答案，正文 485px；历史问答仍保存在 history 数据中 |
| 上/下一页 | 翻页目标随内容溢出情况切换，首次下一页已在底部 | 固定同一个正文节点；511px 视口下一页移动 434px，再上一页回到 0 |
| 流式追加 | 自动追尾可能拉走当前阅读位置 | 手动翻到 scrollTop=381，追加内容使总高 1694→1729，位置仍为 381 |
| 正文排版 | Markdown 段落继承聊天气泡的 10px 12px padding，字号 13.5px | 段落 padding=0，正文 16px；固定翻页条留在正文上方 |
| 浏览器预览 | 旧 440×720 说明与聊天气泡演示 | 同步 780×760 窗口和单一题解渲染管线；完整发送使用 live 模式 |

这些数字来自同一受控 Markdown/SSE 响应回放，目的在于隔离模型内容和网络波动。修改前后是**左右自身两个版本**，不是 Gank 实机像素对照。截图保存在本地忽略目录：

- `output/playwright/reading-before-returned.png`、`reading-after-returned.png`
- `output/playwright/reading-before-second.png`、`reading-after-second.png`
- `output/playwright/reading-regression.log`、`reading-native-top.png`

截图预览切换只选择/放大图片；答案翻页滚动正文，不按截图序号切换答案。Gank 包内也没有已证实的“第 N 张截图对应第 N 个答案”选择器。

## REA 与 Gank 证据范围

复用 `/tmp/rea-run/node_modules/.bin/rea` 6.7.0 和 `/tmp/rea-pkg/rea-main/.agents/skills/reverse-engineer-anything/SKILL.md`，没有修改 MCP 配置。安装包声明 Gank Interview 2.4.0。

原静态 Evidence：`ev_e9fd596c9dbaac3e70ad7136081e31342eb17b444b14dab3f612f798f3871ac1`。随后用普通源码控制流复核 renderer `r0c98ae6f-DM3WYGOB.js`，SHA-256 为 `d4c967c5eeeb36f25e3a980c7f10173df76c9d1451db5154908a9e22f2bf9401`：

- 截图组件 MV：UTF-8 字节 `[2042229,2047662)`；单一当前 Markdown、固定阅读 ref、按钮按 `min(H,max(.85H,200))` 滚动。
- 状态 owner FV：`[2047868,2053054)`；新非追问题移除旧 solution，stream 更新当前内容，没有历史答案列表。
- 24px 自动追尾：`[587062,587951)`，属于语音组件。之前把它用于截图阅读的结论有误，本轮已纠正。
- MV 中未发现显式滚动复位或自动追尾 effect；不能据此保证 Gank 每次新题都归零。

完整片段、摘要和范围记录在 `output/rea/reading-comparison-excerpts.json` 与 `reading-differences.md`。这是包内静态控制流证据，不是 REA 对整个 bundle 的语义分析结果。

本轮也启动查看了 Gank 的空闲窗口，但未取得可用的真实答案截图；因此不声称完成 Gank 回答页的运行时像素对照。Electron fuses Evidence 为 `ev_d5e3077a49b66479e84664866dae87d2d40afcb6bd6029610fc02d2b8ccca37c`，它只证明相应打包标志。

REA 对左右安装版进行被动页面检查，Evidence 为 `ev_9b04f32a561805bcea7a2c4e652a180bbc4609158d43dde47d7466df7c2115c8`，结果保存于 `output/rea/reading-native-observation.json`。受控答案经安装版粘贴/发送入口回放，实测单一答案、翻页条可见、初始 scrollTop=0、正文 511px。原生 AX 点击上/下一页后通过 CDP 读取滚动位置，上一页从 686.5→184，591px 视口移动 502.5px，符合 85% 步长。

## 验证与交付

- Node 渲染、共享存储与快捷键测试：12 passed。
- API 测试：106 passed，有一条既有 Starlette/httpx 弃用提示。上一轮全量 Python 为 415 passed；本轮未改后端业务逻辑。
- 浏览器回归通过：返回位置、上下翻页、第二题高度、固定阅读目标、流式追加保留位置；预览页单一题解与翻页条通过。
- `npm run dist` 构建完成，DMG 校验通过；100 个前端资源文件（排除 Finder `.DS_Store`）在源码、构建版和安装版之间哈希一致，构建与安装的 `app.asar` 一致。
- 安装前备份在 `output/reading-installed-backup/`。临时浏览器和调试端口在验收后关闭，8001/9958 正式服务保留。

可重放浏览器用例（需先启动本地 8001/9958 服务及 Playwright CLI 浏览器会话）：

```sh
mkdir -p output/playwright
/Users/why/.codex/skills/playwright/scripts/playwright_cli.sh -s=reading open http://127.0.0.1:9958/index.html
/Users/why/.codex/skills/playwright/scripts/playwright_cli.sh -s=reading run-code "$(cat tests/browser/reading-flow.js)"
```

## 仍有不足

1. 原生安装版报告 23 个快捷键均注册成功，回调/翻页路径已有测试；本轮 CUA 模拟 `⌘.` 没有产生滚动。尚未区分全局输入注入限制与真实物理按键故障，因此不把系统级快捷键端到端验收标为通过。可见翻页按钮已实测可用。
2. Gank 的代码复制/行号、缩略图位置与自适应尺寸仍有差异；本轮先修复影响阅读的高度与滚动问题，没有宣称完整复刻。
3. 真实模型的延迟波动与偶发断流仍是上一轮发现的独立问题；本轮受控回放不证明这些问题已解决。
