#!/usr/bin/env node
/**
 * DSH 会话附件修复工具。
 *
 * 只做一件事：把会话日志里"引用的附件对象已不存在"的 image/file 内容块
 * 替换成文本占位，使会话能重新发出消息。默认只生成副本并校验，
 * 加 --apply 才备份并写回。
 *
 * 依赖：Node.js >= 22.15（需要 zlib 的 zstd 同步编解码）。仅用标准库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const PLACEHOLDER_RE = /^\[(图片|文件附件)已不可用：/;
const LOG_NAME = 'session.v3.jsonl.zstd';

function fail(message, code = 2) {
  console.error(`错误: ${message}`);
  process.exit(code);
}

function checkRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22 || typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
    fail(`需要 Node.js >= 22.15（当前 ${process.versions.node}，zstd 支持不可用）`);
  }
}

function resolveHome(explicit) {
  const home = explicit ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  if (!fs.existsSync(home)) fail(`DSH 主目录不存在: ${home}`);
  return home;
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- zstd 多帧读写 ----------

function frameSpans(buf) {
  const spans = [];
  let p = 0;
  while (p < buf.length) {
    const start = p;
    if (p + 4 > buf.length) fail(`第 ${start} 字节处只剩不足一个帧头`);
    const magic = buf.readUInt32LE(p);
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (p + 8 > buf.length) fail(`第 ${start} 字节处的 skippable 帧被截断`);
      p += 8 + buf.readUInt32LE(p + 4);
    } else {
      if (magic !== ZSTD_MAGIC) fail(`第 ${start} 字节处不是 zstd 帧头（0x${magic.toString(16)}）`);
      let q = p + 4;
      const descriptor = buf[q];
      q += 1;
      const fcsFlag = descriptor >> 6;
      const singleSegment = (descriptor >> 5) & 1;
      const checksum = (descriptor >> 2) & 1;
      const dictFlag = descriptor & 3;
      if (!singleSegment) q += 1;
      q += [0, 1, 2, 4][dictFlag];
      q += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
      for (;;) {
        if (q + 3 > buf.length) fail(`第 ${start} 字节处的 zstd 帧块头被截断`);
        const header = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
        q += 3;
        const lastBlock = header & 1;
        const blockType = (header >> 1) & 3;
        const blockSize = header >>> 3;
        if (blockType === 0 || blockType === 2) q += blockSize;
        else if (blockType === 1) q += 1;
        else fail(`第 ${start} 字节处的 zstd 帧含保留块类型`);
        if (lastBlock) break;
      }
      if (checksum) q += 4;
      p = q;
    }
    if (p > buf.length) fail(`第 ${start} 字节处的 zstd 帧越界`);
    spans.push([start, p]);
  }
  return spans;
}

function decodeBuffer(buf) {
  const spans = frameSpans(buf);
  const frames = spans.map(([a, b]) => {
    const text = zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8');
    const parts = text.split('\n');
    if (parts[parts.length - 1] !== '') fail('日志帧以不完整的一行结束，拒绝改写');
    parts.pop();
    return { span: [a, b], lines: parts };
  });
  const lines = frames.flatMap((frame) => frame.lines);
  return { buf, frames, lines };
}

function readLog(file) {
  return decodeBuffer(fs.readFileSync(file));
}

function encodeLog(frames) {
  return Buffer.concat(frames.map((frame) => zlib.zstdCompressSync(Buffer.from(frame.lines.join('\n') + '\n', 'utf8'))));
}

// ---------- 附件引用 ----------

function shaOf(attachmentId) {
  const match = String(attachmentId ?? '').match(/[0-9a-f]{64}/);
  return match ? match[0] : null;
}

function attachmentPaths(attachmentsRoot, type, sha) {
  const prefix = sha.slice(0, 2);
  return type === 'image'
    ? [path.join(attachmentsRoot, 'objects', prefix, sha)]
    : [path.join(attachmentsRoot, 'file-objects', prefix, sha), path.join(attachmentsRoot, 'files', prefix, sha)];
}

function makeDanglingTest(attachmentsRoot) {
  return (block) => {
    if (!block || (block.type !== 'image' && block.type !== 'file')) return false;
    const sha = shaOf(block.attachment?.attachmentId);
    if (!sha) return false;
    return !attachmentPaths(attachmentsRoot, block.type, sha).some((candidate) => fs.existsSync(candidate));
  };
}

function placeholderFor(block) {
  const attachment = block.attachment ?? {};
  const name = attachment.name ?? '未命名附件';
  const bytes = typeof attachment.bytes === 'number' ? `${attachment.bytes} 字节` : '大小未知';
  const dims = typeof attachment.width === 'number' && typeof attachment.height === 'number' ? `${attachment.width}x${attachment.height}，` : '';
  const kind = block.type === 'image' ? '图片' : '文件附件';
  return { type: 'text', text: `[${kind}已不可用：${name}（${dims}${bytes}）——原附件对象已从本地附件库丢失，无法再随请求发送，已用此占位替代]` };
}

// ---------- 变换与校验 ----------

function replaceDangling(node, isDangling) {
  let replaced = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        if (isDangling(item)) {
          out.push(placeholderFor(item));
          replaced += 1;
          continue;
        }
        out.push(visit(item));
      }
      return out;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = visit(child);
      return out;
    }
    return value;
  };
  return { value: visit(node), replaced };
}

function diffOnlyPlaceholders(before, after, isDangling) {
  const problems = [];
  let replaced = 0;
  const compare = (x, y, at) => {
    if (x === y) return;
    if (isDangling(x) && y && y.type === 'text' && typeof y.text === 'string' && PLACEHOLDER_RE.test(y.text)) {
      replaced += 1;
      return;
    }
    if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') {
      problems.push(`值变化 @${at}`);
      return;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
        problems.push(`数组结构变化 @${at}`);
        return;
      }
      for (let i = 0; i < x.length; i += 1) compare(x[i], y[i], `${at}[${i}]`);
      return;
    }
    const keysBefore = Object.keys(x);
    const keysAfter = Object.keys(y);
    if (keysBefore.length !== keysAfter.length || keysBefore.some((key, i) => key !== keysAfter[i])) {
      problems.push(`键集变化 @${at}`);
      return;
    }
    for (const key of keysBefore) compare(x[key], y[key], `${at}.${key}`);
  };
  compare(before, after, '$');
  return { problems, replaced };
}

function walkBlocks(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walkBlocks(item, visit);
    return;
  }
  if (node && typeof node === 'object') {
    if (node.type === 'image' || node.type === 'file' || (node.type === 'text' && typeof node.text === 'string')) visit(node);
    for (const child of Object.values(node)) walkBlocks(child, visit);
  }
}

function summarize(lines, isDangling) {
  let attachmentBlocks = 0;
  let imageBlocks = 0;
  let fileBlocks = 0;
  let danglingBlocks = 0;
  let placeholders = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail('日志中存在无法解析的事件行');
    }
    walkBlocks(event, (block) => {
      if (block.type === 'image' || block.type === 'file') {
        attachmentBlocks += 1;
        if (block.type === 'image') imageBlocks += 1;
        else fileBlocks += 1;
        if (isDangling(block)) danglingBlocks += 1;
      } else if (PLACEHOLDER_RE.test(block.text)) {
        placeholders += 1;
      }
    });
  }
  return { events: lines.length, attachmentBlocks, imageBlocks, fileBlocks, danglingBlocks, placeholders };
}

// ---------- 会话定位 ----------

function listSessions(sessionsRoot, workspaceFilter) {
  const found = [];
  for (const workspace of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    if (workspaceFilter && workspace.name !== workspaceFilter) continue;
    const workspaceDir = path.join(sessionsRoot, workspace.name);
    for (const session of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const logPath = path.join(workspaceDir, session.name, LOG_NAME);
      if (fs.existsSync(logPath)) {
        found.push({ workspace: workspace.name, session: session.name, dir: path.join(workspaceDir, session.name), logPath });
      }
    }
  }
  return found;
}

function resolveSession(sessionsRoot, sessionArg) {
  const matches = listSessions(sessionsRoot).filter((entry) => entry.session === sessionArg);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) fail(`会话 id 在多个工作区重复: ${sessionArg}`);
  const absolute = path.resolve(sessionArg);
  if (fs.existsSync(path.join(absolute, LOG_NAME))) {
    return { workspace: path.basename(path.dirname(absolute)), session: path.basename(absolute), dir: absolute, logPath: path.join(absolute, LOG_NAME) };
  }
  fail(`找不到会话: ${sessionArg}`);
  return null;
}

function backupPath(logPath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  let candidate = `${logPath}.bak-${stamp}`;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${logPath}.bak-${stamp}-${index}`;
    index += 1;
  }
  return candidate;
}

// ---------- 子命令 ----------

function commandScan(options) {
  const home = resolveHome(options.home);
  const sessionsRoot = path.join(home, 'sessions');
  const attachmentsRoot = path.join(home, 'attachments', 'v1');
  if (!fs.existsSync(sessionsRoot)) fail(`会话目录不存在: ${sessionsRoot}`);
  if (!fs.existsSync(attachmentsRoot)) fail(`附件库不存在: ${attachmentsRoot}`);
  const isDangling = makeDanglingTest(attachmentsRoot);
  const rows = [];
  for (const entry of listSessions(sessionsRoot, options.workspace)) {
    const summary = summarize(readLog(entry.logPath).lines, isDangling);
    if (summary.danglingBlocks === 0 && !options.all) continue;
    rows.push({ workspace: entry.workspace, session: entry.session, ...summary });
  }
  if (options.json) {
    console.log(JSON.stringify({ home, rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('扫描完成：没有任何会话引用缺失的附件对象，不属于本流程。');
    return;
  }
  console.log(`扫描完成：命中 ${rows.length} 个会话`);
  for (const row of rows) {
    console.log(`  ${row.session}  悬空=${row.danglingBlocks}  图片=${row.imageBlocks}  文件=${row.fileBlocks}  占位=${row.placeholders}  工作区=${row.workspace}`);
  }
}

function buildRepair(entry, attachmentsRoot) {
  const isDangling = makeDanglingTest(attachmentsRoot);
  const log = readLog(entry.logPath);
  const frames = [];
  const linesBefore = [];
  const linesAfter = [];
  let changedLines = 0;
  let replacedBlocks = 0;
  for (const frame of log.frames) {
    const outLines = [];
    for (const line of frame.lines) {
      linesBefore.push(line);
      if (!line.trim()) {
        outLines.push(line);
        linesAfter.push(line);
        continue;
      }
      const event = JSON.parse(line);
      const { value, replaced } = replaceDangling(event, isDangling);
      if (replaced === 0) {
        outLines.push(line);
        linesAfter.push(line);
        continue;
      }
      const serialized = JSON.stringify(value);
      changedLines += 1;
      replacedBlocks += replaced;
      outLines.push(serialized);
      linesAfter.push(serialized);
    }
    frames.push({ lines: outLines });
  }
  // 独立校验：逐行逐节点确认差异只发生在"悬空附件 -> 占位文本"
  const problems = [];
  let verified = 0;
  if (linesBefore.length !== linesAfter.length) problems.push('行数发生变化');
  for (let i = 0; i < Math.min(linesBefore.length, linesAfter.length); i += 1) {
    if (linesBefore[i] === linesAfter[i]) continue;
    const before = JSON.parse(linesBefore[i]);
    const after = JSON.parse(linesAfter[i]);
    if (before.seq !== after.seq || before.type !== after.type || before.time !== after.time || before.id !== after.id) {
      problems.push(`第 ${i + 1} 行标识字段变化`);
    }
    const diff = diffOnlyPlaceholders(before, after, isDangling);
    verified += diff.replaced;
    for (const problem of diff.problems) problems.push(`第 ${i + 1} 行 ${problem}`);
  }
  const encoded = encodeLog(frames);
  return {
    entry,
    encoded,
    changedLines,
    replacedBlocks,
    verification: { problems, replaced: verified },
    summaryBefore: summarize(linesBefore, isDangling),
    summaryAfter: summarize(linesAfter, isDangling),
  };
}

function commandRepair(options) {
  if (!options.session) fail('缺少 --session');
  const home = resolveHome(options.home);
  const attachmentsRoot = path.join(home, 'attachments', 'v1');
  const entry = resolveSession(path.join(home, 'sessions'), options.session);
  const result = buildRepair(entry, attachmentsRoot);
  const workDir = options.work ?? path.join(os.tmpdir(), 'dsh-attachment-repair');
  fs.mkdirSync(workDir, { recursive: true });
  const candidate = path.join(workDir, `${entry.session}.repaired.zstd`);
  fs.writeFileSync(candidate, result.encoded);

  console.log(`会话: ${entry.session}`);
  console.log(`  改动行: ${result.changedLines}   替换附件块: ${result.replacedBlocks}`);
  console.log(`  修复前悬空附件块: ${result.summaryBefore.danglingBlocks}`);
  console.log(`  校验: ${result.verification.problems.length === 0 ? 'PASS' : 'FAIL'}（替换计数 ${result.verification.replaced}）`);
  if (result.verification.problems.length > 0) {
    for (const problem of result.verification.problems.slice(0, 5)) console.log(`    - ${problem}`);
    fail('校验未通过，未写入任何会话文件');
  }
  if (result.verification.replaced !== result.replacedBlocks) fail('替换数量与校验计数不一致，未写入');
  if (result.summaryAfter.danglingBlocks !== 0) fail('修复后仍有悬空附件，未写入');
  if (result.changedLines === 0) {
    console.log('该会话没有需要修复的附件引用。');
    return;
  }
  console.log(`  修复副本: ${candidate}`);

  if (!options.apply) {
    console.log('\n未写入会话目录。确认后加 --apply 备份并写入，然后重启宿主服务端。');
    return;
  }
  const backup = backupPath(entry.logPath);
  fs.copyFileSync(entry.logPath, backup);
  if (hashFile(entry.logPath) !== hashFile(backup)) fail(`备份校验失败: ${backup}`);
  fs.writeFileSync(entry.logPath, result.encoded);
  if (hashFile(entry.logPath) !== hashFile(candidate)) fail(`写入后哈希与副本不一致: ${entry.logPath}`);
  console.log(`  已备份: ${backup}`);
  console.log(`  已写入: ${entry.logPath}`);
  console.log('\n下一步：重启宿主服务端，再在该会话里发一条消息复验。');
}

function commandVerify(options) {
  if (!options.session) fail('缺少 --session');
  const home = resolveHome(options.home);
  const entry = resolveSession(path.join(home, 'sessions'), options.session);
  const summary = summarize(readLog(entry.logPath).lines, makeDanglingTest(path.join(home, 'attachments', 'v1')));
  console.log(`会话: ${entry.session}`);
  console.log(`  事件行: ${summary.events}   附件块: ${summary.attachmentBlocks}（图片 ${summary.imageBlocks} / 文件 ${summary.fileBlocks}）`);
  console.log(`  悬空附件块: ${summary.danglingBlocks}   占位: ${summary.placeholders}`);
  console.log(`  结论: ${summary.danglingBlocks === 0 ? 'PASS 已无悬空附件' : 'FAIL 仍有悬空附件'}`);
  if (summary.danglingBlocks !== 0) process.exitCode = 1;
}

function commandRestore(options) {
  if (!options.session) fail('缺少 --session');
  if (!options.backup) fail('缺少 --backup');
  const home = resolveHome(options.home);
  const entry = resolveSession(path.join(home, 'sessions'), options.session);
  const backup = path.resolve(options.backup);
  if (!fs.existsSync(backup)) fail(`备份不存在: ${backup}`);
  decodeBuffer(fs.readFileSync(backup));
  const safety = backupPath(entry.logPath);
  fs.copyFileSync(entry.logPath, safety);
  fs.copyFileSync(backup, entry.logPath);
  if (hashFile(entry.logPath) !== hashFile(backup)) fail('还原后哈希与备份不一致');
  console.log(`已还原: ${entry.logPath}`);
  console.log(`  还原前的状态另存为: ${safety}`);
  console.log('  还原后同样需要重启宿主服务端才会生效。');
}

function commandSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-repair-selftest-'));
  try {
    const home = path.join(tmp, 'home');
    const attachmentsRoot = path.join(home, 'attachments', 'v1');
    const sessionDir = path.join(home, 'sessions', 'ws-demo', 'session-demo');
    fs.mkdirSync(sessionDir, { recursive: true });
    const goodSha = 'a'.repeat(64);
    const badSha = 'b'.repeat(64);
    fs.mkdirSync(path.join(attachmentsRoot, 'objects', goodSha.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(attachmentsRoot, 'objects', goodSha.slice(0, 2), goodSha), 'x');
    const events = [
      { type: 'session', version: 3, id: 'session-demo', createdAt: 1, cwd: '/tmp/demo' },
      { type: 'user/message', seq: 1, time: 2, data: { message: { role: 'user', content: [
        { type: 'text', text: '看这两张图' },
        { type: 'image', attachment: { attachmentId: `sha256:${goodSha}`, name: 'ok.png', bytes: 1, width: 2, height: 2 } },
        { type: 'image', attachment: { attachmentId: `sha256:${badSha}`, name: 'gone.png', bytes: 9, width: 3, height: 4 } },
      ] } } },
    ];
    const lines = events.map((event) => JSON.stringify(event));
    // 两个帧，验证多帧读写
    const firstFrame = zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'));
    const secondFrame = zlib.zstdCompressSync(Buffer.from(lines[1] + '\n', 'utf8'));
    fs.writeFileSync(path.join(sessionDir, LOG_NAME), Buffer.concat([firstFrame, secondFrame]));

    const entry = resolveSession(path.join(home, 'sessions'), 'session-demo');
    const result = buildRepair(entry, attachmentsRoot);
    const checks = [
      ['替换块数 = 1', result.replacedBlocks === 1],
      ['校验无问题', result.verification.problems.length === 0],
      ['校验计数一致', result.verification.replaced === 1],
      ['修复后无悬空', result.summaryAfter.danglingBlocks === 0],
      ['保留有效图片', result.summaryAfter.imageBlocks === 1],
      ['占位已写入', result.summaryAfter.placeholders === 1],
      ['事件行不变', result.summaryAfter.events === events.length],
    ];
    const backup = backupPath(entry.logPath);
    fs.copyFileSync(entry.logPath, backup);
    fs.writeFileSync(entry.logPath, result.encoded);
    checks.push(['写入后行数不变', readLog(entry.logPath).lines.length === events.length]);
    checks.push(['写入后备份可比对', hashFile(backup) !== hashFile(entry.logPath)]);
    fs.copyFileSync(backup, entry.logPath);
    checks.push(['备份可还原', JSON.stringify(readLog(entry.logPath).lines) === JSON.stringify(lines)]);

    let failed = 0;
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) failed += 1;
    }
    if (failed > 0) fail(`${failed} 项自检失败`, 1);
    console.log('自检通过');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 参数 ----------

const VALUE_FLAGS = new Set(['home', 'workspace', 'session', 'work', 'backup']);
const BOOLEAN_FLAGS = new Set(['json', 'all', 'apply']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) fail(`无法识别的参数: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      // 取值允许以 "--" 开头：DSH 的工作区目录名本身就以 -- 起头。
      const value = rest[i + 1];
      if (value === undefined) fail(`参数 ${token} 缺少取值`);
      options[name] = value;
      i += 1;
    } else {
      fail(`无法识别的参数: ${token}`);
    }
  }
  return options;
}

const USAGE = `用法:
  node repair_session.mjs scan    [--home <DSH 主目录>] [--workspace <工作区目录名>] [--all] [--json]
  node repair_session.mjs repair  --session <会话 id 或目录> [--apply] [--work <工作目录>] [--home <DSH 主目录>]
  node repair_session.mjs verify  --session <会话 id 或目录> [--home <DSH 主目录>]
  node repair_session.mjs restore --session <会话 id 或目录> --backup <备份文件> [--home <DSH 主目录>]
  node repair_session.mjs self-test

DSH 主目录默认取 $DSH_HOME，否则 ~/.dsh。`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === undefined || options.command === '--help' || options.command === '-h' || options.command === 'help') {
    console.log(USAGE);
    return;
  }
  checkRuntime();
  switch (options.command) {
    case 'scan': commandScan(options); break;
    case 'repair': commandRepair(options); break;
    case 'verify': commandVerify(options); break;
    case 'restore': commandRestore(options); break;
    case 'self-test': commandSelfTest(); break;
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main();
