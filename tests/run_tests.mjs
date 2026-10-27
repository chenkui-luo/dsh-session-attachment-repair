#!/usr/bin/env node
/**
 * 回归测试：验证 repair_session.mjs 的编解码、子命令行为与退出码。
 * 全部使用临时目录与合成会话，不触碰真实 DSH 数据。
 *
 * 子进程输出写入临时文件而不是管道：受限沙箱里管道捕获可能被拒绝。
 *
 * 运行：node tests/run_tests.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'repair_session.mjs');
const LOG_NAME = 'session.v3.jsonl.zstd';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-repair-tests-'));
let spawnIndex = 0;

function run(args) {
  spawnIndex += 1;
  const outFile = path.join(TMP, `out-${spawnIndex}.txt`);
  const errFile = path.join(TMP, `err-${spawnIndex}.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let status;
  try {
    status = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', outFd, errFd] }).status;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') };
}

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n      ${detail.replace(/\n/g, '\n      ').slice(0, 800)}`}`);
}

function makeHome(root, { dangling = true } = {}) {
  const home = path.join(root, 'home');
  const attachments = path.join(home, 'attachments', 'v1');
  const sessionDir = path.join(home, 'sessions', 'ws-demo', 'session-demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  const goodSha = 'a'.repeat(64);
  const badSha = 'b'.repeat(64);
  fs.mkdirSync(path.join(attachments, 'objects', goodSha.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(attachments, 'objects', goodSha.slice(0, 2), goodSha), 'x');
  const content = [
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { attachmentId: `sha256:${goodSha}`, name: 'ok.png', bytes: 1, width: 2, height: 2 } },
  ];
  if (dangling) {
    content.push({ type: 'image', attachment: { attachmentId: `sha256:${badSha}`, name: 'gone.png', bytes: 9, width: 3, height: 4 } });
  }
  const events = [
    { type: 'session', version: 3, id: 'session-demo', createdAt: 1, cwd: '/tmp/demo' },
    { type: 'user/message', seq: 1, time: 2, data: { message: { role: 'user', content } } },
    { type: 'session/title', seq: 2, time: 3, data: { title: '测试会话' } },
  ];
  const frames = [
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(events[0]) + '\n', 'utf8')),
    zlib.zstdCompressSync(Buffer.from(events.slice(1).map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')),
  ];
  fs.writeFileSync(path.join(sessionDir, LOG_NAME), Buffer.concat(frames));
  return { home, sessionDir, logPath: path.join(sessionDir, LOG_NAME) };
}

try {
  // 1. 内置自检
  const selfTest = run(['self-test']);
  check('self-test 通过', selfTest.status === 0 && selfTest.stdout.includes('自检通过'), selfTest.stderr);

  // 2. 帮助与参数错误
  const help = run([]);
  check('无参数时打印用法', help.status === 0 && help.stdout.includes('用法:'), help.stderr);
  const badFlag = run(['scan', '--nope']);
  check('未知参数以退出码 2 结束', badFlag.status === 2 && badFlag.stderr.includes('无法识别'), `status=${badFlag.status} ${badFlag.stderr}`);
  const noSession = run(['repair']);
  check('repair 缺 --session 时报错退出', noSession.status === 2 && noSession.stderr.includes('--session'), `status=${noSession.status}`);
  const missingHome = run(['scan', '--home', path.join(TMP, 'not-exist')]);
  check('主目录不存在时以退出码 2 结束', missingHome.status === 2 && missingHome.stderr.includes('不存在'), `status=${missingHome.status}`);

  // 3. 真实流程：扫描 -> 修复(dry-run) -> 写入 -> 体检 -> 回滚
  const real = makeHome(path.join(TMP, 'real'), { dangling: true });
  const before = fs.readFileSync(real.logPath);

  const scan = run(['scan', '--home', real.home]);
  check('scan 命中 1 个会话', scan.status === 0 && scan.stdout.includes('命中 1 个会话'), scan.stdout + scan.stderr);

  const scanJson = run(['scan', '--home', real.home, '--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(scanJson.stdout);
  } catch {
    parsed = null;
  }
  check('scan --json 输出可解析且悬空数为 1', parsed?.rows?.[0]?.danglingBlocks === 1, scanJson.stdout);

  const dry = run(['repair', '--home', real.home, '--session', 'session-demo']);
  check('dry-run 报告 PASS 且未写入', dry.status === 0 && dry.stdout.includes('校验: PASS') && dry.stdout.includes('未写入'), dry.stdout + dry.stderr);
  check('dry-run 不修改日志', fs.readFileSync(real.logPath).equals(before));

  const applied = run(['repair', '--home', real.home, '--session', 'session-demo', '--apply']);
  check('--apply 成功并有备份提示', applied.status === 0 && applied.stdout.includes('已备份'), applied.stdout + applied.stderr);
  check('--apply 确实改写了日志', !fs.readFileSync(real.logPath).equals(before));
  const backups = fs.readdirSync(real.sessionDir).filter((name) => name.includes('.bak-'));
  check('生成了同位备份', backups.length === 1, JSON.stringify(backups));

  const verifyOk = run(['verify', '--home', real.home, '--session', 'session-demo']);
  check('修复后 verify 通过（退出码 0）', verifyOk.status === 0 && verifyOk.stdout.includes('PASS'), verifyOk.stdout + verifyOk.stderr);

  if (backups.length === 1) {
    const restored = run(['restore', '--home', real.home, '--session', 'session-demo', '--backup', path.join(real.sessionDir, backups[0])]);
    check('restore 成功', restored.status === 0 && restored.stdout.includes('已还原'), restored.stdout + restored.stderr);
    check('还原后与原始字节一致', fs.readFileSync(real.logPath).equals(before));
    const verifyFail = run(['verify', '--home', real.home, '--session', 'session-demo']);
    check('还原后 verify 以退出码 1 报悬空', verifyFail.status === 1 && verifyFail.stdout.includes('FAIL'), `status=${verifyFail.status} ${verifyFail.stdout}`);
  }

  // 4. 没有悬空附件时不误改
  const clean = makeHome(path.join(TMP, 'clean'), { dangling: false });
  const cleanBefore = fs.readFileSync(clean.logPath);
  const cleanRepair = run(['repair', '--home', clean.home, '--session', 'session-demo']);
  check('无悬空附件时报告无需修复', cleanRepair.status === 0 && cleanRepair.stdout.includes('没有需要修复'), cleanRepair.stdout + cleanRepair.stderr);
  check('无悬空附件时不改动日志', fs.readFileSync(clean.logPath).equals(cleanBefore));
  const cleanScan = run(['scan', '--home', clean.home]);
  check('无悬空附件时 scan 不命中', cleanScan.status === 0 && cleanScan.stdout.includes('不属于本流程'), cleanScan.stdout + cleanScan.stderr);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error(`失败 ${failed.length} 项`);
  process.exit(1);
}
