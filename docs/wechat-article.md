# 微信公众号文章：bayze-mcp

## 标题

让 AI 帮 AI 把关：一个开源工具，让 DeepSeek 写的答案自动让千问检查、豆包修改

## 正文

---

你有没有这样的经历？

问 AI 一个问题，觉得答案不太放心，想「让另一个 AI 帮忙看看」——于是复制粘贴到另一个聊天窗口，来来回回好几次。

**bayze-mcp** 把这个流程自动化了。

【配图 1：终端演示截图——三家模型协作过程】

---

### 一句话触发三模型协作

在 Cherry Studio 里说一句话：

> 用 review_then_revise_cn 处理：用一句话解释 HTTP 和 HTTPS 的区别

然后你会看到：

**第一步**：DeepSeek 写初稿（约 2 秒）

**第二步**：通义千问评审初稿——给出结构化结论「通过」或「需要修改」（附具体理由）

**第三步**：如果千问说「需要修改」，豆包自动修订并返回改进版

每一步都清楚展示：**用了哪个模型、花了多少 token、耗时多少、费用多少**。

【配图 2：Cherry Studio 对话截图——显示工具调用过程】

---

### 为什么需要多模型交叉复核？

单一模型有「同族盲区」——同一家公司的模型倾向于犯同类错误。

Bayze 让**不同厂商的模型互相检查**：DeepSeek（深度求索）写的东西让通义千问（阿里）审，有问题让豆包（字节）改。三家各有所长，互补短板。

实测数据（15 次真实运行）：
- 通义千问成功识别出 DeepSeek 草稿中缺少 TLS 握手细节
- 豆包修订时准确采纳了千问的纠正建议
- 单次三模型协作成本约 **3 分钱**
- 全程耗时约 **8 秒**

---

### 安装只需 3 分钟

**前置条件**：Node.js ≥ 22（[nodejs.org](https://nodejs.org) 下载）

**第一步：安装工具**

```bash
npm install -g bayze-mcp
```

**第二步：准备 API Key**

你需要至少两家的 API Key（都有免费额度）：
- DeepSeek：[platform.deepseek.com](https://platform.deepseek.com)
- 通义千问：[dashscope.console.aliyun.com](https://dashscope.console.aliyun.com)

**第三步：在 Cherry Studio 里添加**

设置 → MCP 服务器 → 添加：
- 名称：bayze
- 命令：`npx`
- 参数：`-y bayze-mcp mcp --config ~/.bayze/config.yaml`

【配图 3：Cherry Studio MCP 配置截图】

**第四步：开始使用**

在普通聊天里说「用 review_then_revise_cn 处理：……」就行。

---

### 核心特性

| 特性 | 说明 |
|---|---|
| 结构化评审 | 评审必须给出理由，空理由直接拒绝 |
| 费用守卫 | 每次调用前预估费用，超预算自动停止 |
| 隐私保护 | 密钥只在本地，不上传任何数据 |
| 开源免费 | MIT 协议，130 项测试，三平台 CI |

---

### 链接

- **GitHub**：https://github.com/caijianxiong2007-prog/bayze-mcp
- **Gitee 镜像**（国内直连）：https://gitee.com/collection-master/bayze-mcp
- **npm**：https://www.npmjs.com/package/bayze-mcp
- **详细教程**：https://juejin.cn/post/7704542913921581090

---

*Bayze 是本地优先的开源工具：你的 API Key 留在你自己的电脑上，你的对话内容不会经过任何第三方服务器。*

---
