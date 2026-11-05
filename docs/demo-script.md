# Bayze 30 秒演示脚本

目的：录制一段 30 秒 GIF/视频，展示「在 AI 客户端中一句话触发跨厂商多模型复核」的核心价值。

## 前置条件

- Cherry Studio 已安装并配置好 bayze MCP（见 `docs/mcp-clients.md`）
- 环境变量已设（至少 DeepSeek + DashScope + Ark 三家密钥）
- 普通聊天窗口（不是 Agent），bayze 工具已勾选
- 屏幕录制工具就绪（macOS 自带 Cmd+Shift+5 或 OBS）

## 录制分镜（30 秒）

### 第一段：Hook（0-5 秒）

**画面**：Cherry Studio 普通聊天窗口，输入框空白

**操作**：输入以下文字（预先打好，粘贴）

```
用 review_then_revise_cn 处理：用一句话解释 HTTP 和 HTTPS 的区别（严格 150 字以内，要求普通用户能看懂）
```

**旁白/字幕**：`一句话，触发三家 AI 模型协作`

### 第二段：执行过程（5-18 秒）

**画面**：Cherry 显示工具调用进度（`step draft: running` → `step review: running`）

**关键画面**：
- 工具调用指示器出现（证明 MCP 在工作）
- 步骤进度依次变为 running → succeeded
- 如果评审打回（revise），第三步 revise 也会 running

**旁白/字幕**：`DeepSeek 起草 → 通义千问评审 → 豆包按需修订`

### 第三段：结果展示（18-28 秒）

**画面**：Cherry 展示结构化返回

**关键画面**（滚动或高亮）：
- `finalOutput`：修订后的文本
- `reviewSummary`：评审意见（verdict + reasons）
- `steps[]`：每步的模型、耗时、tokens、费用
- `warnings`：账单提示（如有）

**旁白/字幕**：`每一步可审计：哪个模型、多少 token、什么费用`

### 第四段：Call to action（28-30 秒）

**画面**：切到终端，展示安装命令

```bash
npx -y bayze-mcp mcp --config your-config.yaml
```

**旁白/字幕**：`npm install bayze-mcp · 开源 · MIT`

## 录制技巧

1. **用 mock 还是真实模型？** 用真实模型——观众需要看到真实的模型名称和耗时才有信任感
2. **选什么任务？** 用 HTTPS vs HTTP 这个——你已经测过 15 次，知道它会触发有趣的评审行为
3. **字幕要短**：每段一句，不要解释技术细节
4. **如果评审判 accept**：展示 `revise: skipped` 也可以——说明「评审通过就不浪费修订费」
5. **导出格式**：先录 MP4，再转 GIF（用 `ffmpeg -i demo.mp4 -vf "fps=10,scale=640:-1" demo.gif`）
6. **尺寸**：GIF 控制在 5MB 以内（GitHub README 限制）

## 备选脚本（10 秒超短版）

如果只需要一个极短的演示：

```
[0-3s] 输入：「用 quick_answer 回答：什么是 HTTPS」
[3-7s] 等待 ~2s，结果显示
[7-10s] 字幕：「bayze-mcp · npm install bayze-mcp · MIT」
```

这个版本突出了「快」——单步 2 秒返回，成本不到 1 美分。

## 发布位置

录好后放到：
1. `README.md` 顶部（跟 CI 徽章放一起）
2. `README.en.md` 顶部
3. GitHub repo 的 About 区域（如果支持视频）
4. awesome-mcp-servers 的 PR 描述里（补充视觉证据）
