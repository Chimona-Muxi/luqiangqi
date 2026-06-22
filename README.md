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

人机模式里有 4 种 AI 类型：

- 高速策略 AI：浏览器内置算法，速度最快，也是外部模型失效时的兜底。
- 本地千问：通过本机 Ollama 调用 `qwen2.5:14b`。
- 云端大模型：通过 OpenAI 兼容的 Chat Completions API 调用。
- 混合外脑：先尝试本地千问，再尝试云端 API，失败时自动回到高速策略 AI。

本地千问需要先让 Ollama 服务可访问。通常安装 Ollama 后运行过下面命令即可：

```bash
ollama run qwen2.5:14b
```

如果 Ollama 地址或模型名不同，可以在启动游戏时指定：

```bash
LQQ_OLLAMA_URL=http://127.0.0.1:11434 LQQ_OLLAMA_MODEL=qwen2.5:14b node server.mjs
```

云端大模型不会把 key 放到网页里，需要在服务器环境变量中配置：

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

## 规则

- 9x9 棋盘，每名玩家从自己的边中点出发，抵达对边即胜。
- 每回合可以移动一步，或放置一面跨两格的墙。
- 墙不能重叠、穿插，也不能把任何玩家的所有通路完全堵死。
- 2 人每人 10 面墙，3 人每人 6 面墙，4 人每人 5 面墙。
