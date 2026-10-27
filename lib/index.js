/**
 * dsh-plugin-session-attachment-repair — host half.
 *
 * Exposes the repository's own CLI (scripts/repair_session.mjs) over an authenticated
 * same-origin HTTP route, so the Settings card can scan sessions, prepare a repair,
 * back it up and write it, or restore a backup — without a terminal.
 *
 * The CLI stays the single implementation: this file only validates input, runs it,
 * and returns its report text. That keeps the plugin and the Skill from drifting apart.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-session-attachment-repair';

export const inject = ['webServer', 'connection'];

/** Route prefix owned by this plugin (no trailing slash). */
const ROUTE_PREFIX = '/dsh-session-attachment-repair';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'repair_session.mjs');

/** Session ids are directory names; keep the shape narrow and reject path syntax. */
const SESSION_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** A repair run touches a multi-megabyte log, so allow more time than a plain request. */
const TIMEOUT_MS = 120_000;

function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        rejectPromise(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        rejectPromise(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function runCli(args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = [stdout, stderr].map((part) => part.trim()).filter(Boolean).join('\n');
      resolvePromise({
        ok: error === null,
        code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        output,
      });
    });
  });
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid');
  if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;

  // Trust fence: loopback/trusted Host, matching Origin, valid login cookie.
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return true;
  }

  const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    if (route === 'health' && method === 'GET') {
      sendJson(res, { ok: true, cli: CLI });
      return true;
    }

    if (route === 'scan' && method === 'POST') {
      const body = await readJsonBody(req);
      const args = ['scan', '--all'];
      if (typeof body.workspace === 'string' && body.workspace !== '') {
        if (!SESSION_RE.test(body.workspace)) {
          sendJson(res, { ok: false, error: '工作区名不合法' }, 400);
          return true;
        }
        args.push('--workspace', body.workspace);
      }
      sendJson(res, await runCli(args));
      return true;
    }

    if (route === 'repair' && method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.session !== 'string' || !SESSION_RE.test(body.session)) {
        sendJson(res, { ok: false, error: '缺少合法的 session' }, 400);
        return true;
      }
      const args = ['repair', '--session', body.session];
      if (body.apply === true) {
        if (body.confirm !== true) {
          sendJson(res, { ok: false, error: '写入需要 confirm: true（会修改会话日志，脚本会先备份）' }, 400);
          return true;
        }
        args.push('--apply');
      }
      sendJson(res, await runCli(args));
      return true;
    }

    if (route === 'verify' && method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.session !== 'string' || !SESSION_RE.test(body.session)) {
        sendJson(res, { ok: false, error: '缺少合法的 session' }, 400);
        return true;
      }
      const result = await runCli(['verify', '--session', body.session]);
      // verify 用退出码 1 表示"仍有悬空附件"，那是结果而不是故障。
      sendJson(res, { ok: true, code: result.code, output: result.output });
      return true;
    }

    if (route === 'restore' && method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.session !== 'string' || !SESSION_RE.test(body.session)) {
        sendJson(res, { ok: false, error: '缺少合法的 session' }, 400);
        return true;
      }
      if (typeof body.backup !== 'string' || body.backup === '') {
        sendJson(res, { ok: false, error: '缺少 backup 路径' }, 400);
        return true;
      }
      if (body.confirm !== true) {
        sendJson(res, { ok: false, error: '还原需要 confirm: true' }, 400);
        return true;
      }
      sendJson(res, await runCli(['restore', '--session', body.session, '--backup', body.backup]));
      return true;
    }

    sendJson(res, { ok: false, error: `未知接口：${method} ${url.pathname}` }, 404);
    return true;
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => { void handle(ctx, req, res); },
  }), 'session-attachment-repair: http routes');
}
