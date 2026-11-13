import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectClientTargets,
  registerToClient,
  bayzeEntryJSON,
} from '../../src/config/client-register.js';

/* 探测与注册逻辑测试：临时目录模拟客户端配置文件（真实路径探测在用户机器验证） */

test('bayzeEntryJSON：command/args 与 init Cherry JSON 同构', () => {
  const e = bayzeEntryJSON('/Users/x/.bayze/config.yaml');
  assert.equal(e.command, 'npx');
  assert.deepEqual(e.args, ['-y', 'bayze-mcp', 'mcp', '--config', '/Users/x/.bayze/config.yaml']);
});

test('registerToClient：空 mcpServers 的客户端文件 → 写入 bayze-mcp 条目 + 备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayze-reg-'));
  const cfg = join(dir, 'claude_desktop_config.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
  const r = registerToClient({ id: 'claude-desktop', label: 'Claude Desktop', configPath: cfg }, '/Users/x/.bayze/config.yaml');
  assert.equal(r.added, true);
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(parsed.mcpServers['bayze-mcp']);
  assert.equal(parsed.mcpServers['bayze-mcp'].command, 'npx');
  assert.ok(existsSync(cfg + '.bak'), '应有备份');
  rmSync(dir, { recursive: true, force: true });
});

test('registerToClient：非法 JSON 的客户端文件 → 跳过不破坏', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayze-reg-'));
  const cfg = join(dir, 'cursor_mcp.json');
  writeFileSync(cfg, 'not-json{{{');
  const r = registerToClient({ id: 'cursor', label: 'Cursor', configPath: cfg }, '/Users/x/.bayze/config.yaml');
  assert.equal(r.added, false);
  assert.equal(readFileSync(cfg, 'utf8'), 'not-json{{{', '用户文件不被破坏');
  rmSync(dir, { recursive: true, force: true });
});

test('registerToClient：重复注册幂等（bayze-mcp 已存在时刷新不叠加）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayze-reg-'));
  const cfg = join(dir, 'cfg.json');
  const entry = bayzeEntryJSON('/Users/x/.bayze/config.yaml');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { 'bayze-mcp': entry } }));
  const r = registerToClient({ id: 'x', label: 'X', configPath: cfg }, '/Users/x/.bayze/config.yaml');
  assert.equal(r.added, false);
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(Object.keys(parsed.mcpServers).length, 1, '不叠加重复条目');
  rmSync(dir, { recursive: true, force: true });
});

test('registerToClient：保留客户端文件里已有的其他 mcpServers 条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayze-reg-'));
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { 'other-server': { command: 'uvx', args: ['other'] } } }));
  const r = registerToClient({ id: 'x', label: 'X', configPath: cfg }, '/Users/x/.bayze/config.yaml');
  assert.equal(r.added, true);
  const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(parsed.mcpServers['other-server'], '已有条目保留');
  assert.ok(parsed.mcpServers['bayze-mcp'], '新条目写入');
  rmSync(dir, { recursive: true, force: true });
});

test('detectClientTargets：只返回配置文件存在的客户端', () => {
  // 真实机器探测——结果取决于安装了什么客户端，只验证返回结构
  const targets = detectClientTargets();
  assert.ok(Array.isArray(targets));
  for (const t of targets) {
    assert.ok(t.id && t.label && t.configPath);
    assert.ok(existsSync(t.configPath), `${t.id} 的配置文件必须存在`);
  }
});
