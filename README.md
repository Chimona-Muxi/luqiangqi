# 墙路棋

一个本地浏览器版墙路棋。支持人机、同屏多人，以及 2/3/4 人房间联机。

## 启动

双击 `启动游戏.command` 可本机试玩。
如果要让同一局域网的朋友加入，双击 `局域网联机.command`。它会使用 5175 端口，并在窗口里显示其他设备该打开的网址。

也可以在终端运行：

```bash
cd /Applications/My_VSCode_project/2026/6/21/墙路棋
node server.mjs
```

打开：

```text
http://localhost:5174
```

同一局域网内联机时，让其他玩家打开你的电脑局域网地址加端口，然后输入房间码即可。
如果需要让局域网内其他设备访问，可以这样启动：

```bash
HOST=0.0.0.0 PORT=5175 node server.mjs
```

## 部署

这个项目可以部署到支持 Node.js 的 Web Service 平台。服务会读取平台提供的 `PORT` 环境变量。

Render 部署时可以直接使用仓库里的 `render.yaml`，启动命令是：

```bash
node server.mjs
```

## 外部 AI

左侧的“外脑”是独立模式，和“人机 / 同屏 / 联机”并列。

- 本地模型：用户在页面填写 Ollama 地址和模型名，默认示例是 `qwen2.5:14b`。
- 云端 API：用户在页面填写自己的 API key、接口地址和模型名；这些内容随单次请求发送，不写入仓库。
- 高速策略 AI 仍然是原来的人机模式，也会作为外脑不可用时的兜底。

本地千问需要先让 Ollama 服务可访问。通常安装 Ollama 后运行过下面命令即可：

```bash
ollama run qwen2.5:14b
```

如果 Ollama 地址或模型名不同，可以在启动游戏时指定：

```bash
LQQ_OLLAMA_URL=http://127.0.0.1:11434 LQQ_OLLAMA_MODEL=qwen2.5:14b node server.mjs
```

如果不想每次在页面输入，云端大模型也可以在服务器环境变量中预设：

```text
LQQ_LLM_API_KEY=你的 API key
LQQ_LLM_MODEL=模型名
LQQ_LLM_BASE_URL=https://api.openai.com/v1
```

如果是其他 OpenAI 兼容服务，也可以直接设置完整地址：

```text
LQQ_LLM_API_URL=https://example.com/v1/chat/completions
```

联机房间还提供外部对战接口。创建房间的返回数据里会包含 `external.stateUrl`、`external.actionUrl` 和 `external.key`，外部程序可以读取局面、选择 `legalActions` 中的 id，再提交动作。

外部 AI 收到的局面会包含规则说明、当前棋局、合法动作列表和返回格式。模型不需要自己计算坐标，只要从 `legalActions` 里选择一个 `id`，服务器会校验并执行落子。

如果外部 AI 只能打开链接、不能稳定发送 POST，也可以使用 GET 形式：

```text
GET /api/external/rooms/房间码/join?key=密钥&seat=1&name=GPT
GET /api/external/rooms/房间码/state?key=密钥&seat=1
GET /api/external/rooms/房间码/action?key=密钥&seat=1&id=move:E8
```

`state?seat=1` 会返回玩家二视角。未入座、未开局或还没轮到玩家二时，`legalActions` 会为空，并给出 `joinUrl`、`stateUrl` 和 `waitingReason`；轮到该座位时才会返回可提交的 `legalActions`。如果 `state` 和 `join` 没有写 `seat`，服务器会优先按外部玩家座位处理，默认是玩家二。

网页里创建房间后，点击“外部接口”的复制按钮，会复制一组完整链接：加入、读局面、落子模板。读局面链接会在复制时自动带上新的 `fresh` 参数，可以直接发给只会打开链接、不能自己拼 URL 的外部模型使用。

`state` 响应里还会返回 `external.nextStateUrl`。如果当前读局面链接是 `fresh=123`，下一次会给出 `fresh=124`，外部模型可以直接打开返回里的完整链接继续刷新。轮到该座位时，每个 `legalActions` 条目也会带完整的 `url`，可以直接打开落子，不需要手动替换 `ACTION_ID`。

## 规则

- 9x9 棋盘，每名玩家从自己的边中点出发，抵达对边即胜。
- 每回合可以移动一步，或放置一面跨两格的墙。
- 墙不能重叠、穿插，也不能把任何玩家的所有通路完全堵死。
- 2 人每人 10 面墙，3 人每人 6 面墙，4 人每人 5 面墙。
