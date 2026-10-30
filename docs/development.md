# 开发

```bash
npm ci
npm test               # 全部单元 / 回归测试
node test/e2e.mjs      # 假 NapCat + 假宿主，跑完整链路（不需要真 QQ）
```

`test/mock-napcat.mjs` 也能单独当调试工具用：

```bash
node test/mock-napcat.mjs --port 3001 --token my-token-2026
# 然后在标准输入敲一行 JSON，就当作 QQ 推来一条事件
```

测试的边界、覆盖到哪、哪些只能手测，见 [TESTING.md](../TESTING.md)。

## 目录

```
src/
├── index.js           插件入口（apply）
├── config.js          schemastery 配置
├── prompts.js         聊天规矩 / persona 拼装（中性默认，不含任何私人设定）
├── session.js         会话管理（QQ 会话 ↔ DSH Agent）
├── workspace.js       每个会话独立工作目录 + AGENTS.md / 记忆区骨架
├── inbound.js         QQ 消息 → agent.followup（含语音转写、图片落盘、引用还原）
├── outbound.js        session/event → QQ 消息
├── tools.js           十个互动工具
├── faces.js           表情包收藏夹（扫描 / 收藏 / 归一化）
├── questions.js       ask_user_question → QQ 问答通道
├── approval.js        授权审批 → QQ 问答通道
├── onebot/client.js   OneBot WebSocket 客户端（自动重连）
├── onebot/segment.js  消息段 / CQ 码解析
└── shared/chunk.js    长文本切块

client.js              设置页（uiOnly 时只挂这一层）
tools/
└── asr.py             离线语音识别脚本（vosk，可选，不装也能跑其它功能）
docs/                  说明文档
test/                  e2e 与 mock
```

## 设置页是怎么接上的

同一个设置页要能在两种宿主里都活着，所以有两条路：

| 路 | 说明 |
| --- | --- |
| ① 宿主路由 `/api/dsh-qq` | `ctx.inject(['webServer'], …)` 运行时注入；拿到就挂 |
| ② 本地服务 `127.0.0.1:34569` | 插件自己 `createServer`；设置页脚本先探 ①，失败自动回退 ② |

本地服务只监听回环地址，CORS 放开是为了让 DSH 页面能跨端口读。`headless` 宿主（`--profile qqbot`）没有网页服务，所以它不会起 ②，也不影响 QQ。

**踩过的坑**：`ctx.effect` 必须挂在长命的父 ctx 上。挂到注入回调的子 ctx 上，回调一结束就被收走——现象是 `api-state.txt` 写着 `ok=true`，前端却一直 404。

## 两条约定

1. **`src/` 里不许出现私人东西**：真实 QQ 号、群里的梗、私人称呼。那些属于配置层的 `persona` / `ownerIds` / `directPrompt`。测试里一律用假号（`10001`、`88888` 这种）。
2. **改行为要能解释「为什么不是另一种」**：这个插件里很多看起来奇怪的判断（比如为什么看门狗查 Established 连接、为什么保活窗按「群 + 人」算）都是踩坑踩出来的，改之前先看 [docs/persona.md](persona.md) 和 [tools/README.md](../tools/README.md) 里记的原因。

## Git 工作流

仓库保留两个远端：`origin` 指向自己的 fork，`upstream` 指向原项目。不要直接在 `main` 上开发；每个问题从最新上游切独立分支：

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch -c fix/short-description
```

提交前至少运行 `npm test` 和 `npm pack --dry-run`。提交按关注点拆分，例如核心修复与 CI 文档分开；不要把本机配置、Token、真实 QQ 号、会话记录或图片缓存放进 Git。

## CI / CD

- `.github/workflows/ci.yml`：每次 push 和 pull request 在 Node 20、22、24 上执行锁定安装、完整测试和打包内容检查。
- `.github/workflows/release.yml`：推送 `vX.Y.Z` 标签时，先校验标签与 `package.json` 版本一致，再运行测试、生成 npm `.tgz`、计算 SHA-256，并创建 GitHub Release。
- fork 默认不自动发布 npm：包名属于上游，误发布既可能失败，也可能污染正式发布渠道。需要 npm 发布时，应由包所有者在受保护的 GitHub Environment 中单独配置 trusted publishing。

发版顺序：先更新 `package.json` 与 `CHANGELOG.md`，合并并确认 CI 通过，再创建并推送同版本标签。CD 只在标签推送后启动。
