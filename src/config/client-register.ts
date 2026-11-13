import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * MCP 客户端自动注册（v1.2.0 / ADR-0006 后续）：
 * 探测本机已安装的 MCP 客户端配置文件，将 bayze-mcp 合并写入其 mcpServers。
 *
 * 设计约束：
 * - JSON 合并而非覆盖：保留客户端文件中已有的其他 mcpServers 条目
 * - 原文件备份为 *.bak（同目录）
 * - 配置文件不存在 = 客户端未安装，跳过不强加
 * - Cherry Studio 存 SQLite，不支持自动注册（实测确认，见营销物料分析文档）
 */

export interface ClientTarget {
  id: string;
  label: string;
  configPath: string;
}

/** 支持自动注册的客户端及其配置文件路径（macOS 优先，Linux/Windows 路径尽力探测） */
export function detectClientTargets(): ClientTarget[] {
  const home = homedir();
  const targets: ClientTarget[] = [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      configPath: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
    },
    {
      id: 'vscode',
      label: 'VSCode (Copilot MCP)',
      configPath: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    },
  ];
  // 只返回配置文件已存在的（= 客户端已安装且至少初始化过）
  return targets.filter((t) => existsSync(t.configPath));
}

export interface MergeResult {
  client: string;
  configPath: string;
  backupPath: string;
  added: boolean; // true=新写入，false=已存在同名条目（刷新了配置）
}

/**
 * 将 bayze-mcp 注册写入单个客户端配置文件：
 * 读取 JSON → 合并 mcpServers.bayze-mcp → 备份原文件 → 写回。
 * 配置不是合法 JSON 时跳过（不破坏用户文件）。
 */
export function registerToClient(target: ClientTarget, configPath: string): MergeResult {
  const raw = readFileSync(target.configPath, 'utf8');
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { client: target.label, configPath: target.configPath, backupPath: '', added: false };
  }
  if (!parsed.mcpServers) parsed.mcpServers = {};
  const entryJSON = bayzeEntryJSON(configPath);
  const already = JSON.stringify(parsed.mcpServers['bayze-mcp']) === JSON.stringify(entryJSON);
  if (!already) {
    parsed.mcpServers['bayze-mcp'] = entryJSON;
    // 备份
    copyFileSync(target.configPath, `${target.configPath}.bak`);
    writeFileSync(target.configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  }
  return { client: target.label, configPath: target.configPath, backupPath: `${target.configPath}.bak`, added: !already };
}

/** bayze-mcp 的 mcpServers 条目（与 init 输出的 Cherry JSON 同构） */
export function bayzeEntryJSON(configPath: string): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', 'bayze-mcp', 'mcp', '--config', configPath],
  };
}
