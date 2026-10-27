/**
 * dsh-plugin-session-attachment-repair — browser half.
 *
 * Contributes a Settings page that lists sessions whose history references attachment
 * objects that no longer exist, and repairs them: preview first, then back up and write.
 *
 * Bundle format follows dsh-plugin-restart: the kernel loads client plugins through
 * window.__ModuleLoader__.load with a lazy CommonJS-shaped factory, so this is a classic
 * script. Only `react` is required; the page draws itself with React.createElement and
 * inline styles — no bundler, no CSS pipeline.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-session-attachment-repair',
	factory: (require) => {
		const React = require('react');
		const exports = {};
		const NS = 'sessionAttachmentRepair';
		const API = '/dsh-session-attachment-repair';

		const zh = {
			nav: '会话附件修复',
			title: '会话附件修复',
			intro: '会话能正常打开、历史也看得到，但每次发消息都失败——原因可能是历史引用的图片或文件附件对象已从本地附件库丢失。先扫描，再预览，最后备份并写入。',
			scan: '扫描会话',
			scanning: '扫描中…',
			preview: '预览',
			apply: '备份并写入',
			confirm: '再点一次确认写入',
			restore: '还原',
			busy: '处理中…',
			output: '报告',
			empty: '没有命中需要修复的会话。',
			restart: '写入完成后必须重启服务端，再回到该会话发一条消息复验。',
			restoreHint: '把写入报告里的备份路径填到这里，可以回滚：',
			backupPlaceholder: '备份文件完整路径',
			usage: '命令行：node scripts/repair_session.mjs scan',
			none: '（还没有报告）',
			failed: '请求失败',
		};
		const en = {
			nav: 'Session attachments',
			title: 'Session attachment repair',
			intro: 'A session opens and its history renders, yet sending fails — often because images or files it references are gone from the local attachment store. Scan, preview, then back up and write.',
			scan: 'Scan sessions',
			scanning: 'Scanning…',
			preview: 'Preview',
			apply: 'Back up and write',
			confirm: 'Click again to confirm',
			restore: 'Restore',
			busy: 'Working…',
			output: 'Report',
			empty: 'No session needs repair.',
			restart: 'Restart the server after writing, then send a message in that session to confirm.',
			restoreHint: 'Paste a backup path from a write report to roll back:',
			backupPlaceholder: 'Full path of the backup file',
			usage: 'CLI: node scripts/repair_session.mjs scan',
			none: '(no report yet)',
			failed: 'Request failed',
		};

		const styles = {
			wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' },
			intro: { lineHeight: 1.6, opacity: 0.85 },
			row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
			button: { padding: '6px 12px', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', cursor: 'pointer', opacity: 1 },
			buttonBusy: { padding: '6px 12px', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', cursor: 'default', opacity: 0.5 },
			danger: { padding: '6px 12px', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', cursor: 'pointer', fontWeight: 600 },
			report: { margin: 0, padding: 10, borderRadius: 6, border: '1px solid rgba(128,128,128,0.4)', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 360, overflow: 'auto' },
			hint: { fontSize: 12, opacity: 0.75, lineHeight: 1.5 },
			item: { padding: 10, borderRadius: 6, border: '1px solid rgba(128,128,128,0.4)', display: 'flex', flexDirection: 'column', gap: 8 },
			code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
			input: { padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,0.5)', background: 'transparent', color: 'inherit', minWidth: 280 },
			err: { color: '#d9534f', fontSize: 12 },
		};

		const el = React.createElement;

		/** Parse the CLI scan report into rows; unknown lines are ignored. */
		function parseSessions(report) {
			const rows = [];
			for (const line of report.split('\n')) {
				const match = line.match(/^\s{2}(\S+)\s+悬空=(\d+)\s+图片=(\d+)\s+文件=(\d+)\s+占位=(\d+)\s+工作区=(\S+)\s*$/);
				if (match === null) continue;
				rows.push({
					session: match[1],
					dangling: Number(match[2]),
					images: Number(match[3]),
					files: Number(match[4]),
					placeholders: Number(match[5]),
					workspace: match[6],
				});
			}
			return rows;
		}

		function RepairPage() {
			const [busy, setBusy] = React.useState('');
			const [report, setReport] = React.useState('');
			const [sessions, setSessions] = React.useState([]);
			const [error, setError] = React.useState('');
			const [pending, setPending] = React.useState('');
			const [backup, setBackup] = React.useState('');
			const t = (key, fallback) => (zh[key] ?? fallback ?? key);

			const call = React.useCallback(async (path, body) => {
				const response = await fetch(API + path, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body ?? {}),
				});
				const payload = await response.json().catch(() => ({ ok: false, error: '响应不是 JSON' }));
				if (payload.error !== undefined) throw new Error(payload.error);
				return payload;
			}, []);

			const run = React.useCallback(async (label, path, body) => {
				setBusy(label);
				setError('');
				try {
					const payload = await call(path, body);
					setReport(payload.output ?? JSON.stringify(payload));
					if (path === '/scan') setSessions(parseSessions(payload.output ?? ''));
				} catch (caught) {
					setError(t('failed') + ': ' + (caught instanceof Error ? caught.message : String(caught)));
				} finally {
					setBusy('');
					setPending('');
				}
			}, [call, t]);

			const scan = React.useCallback(() => run(t('scanning'), '/scan', {}), [run, t]);

			const onWrite = (session) => {
				if (pending === session) {
					void run(t('busy'), '/repair', { session, apply: true, confirm: true });
					return;
				}
				setPending(session);
			};

			return el('div', { style: styles.wrap },
				el('div', { style: styles.intro }, t('intro')),
				el('div', { style: styles.row },
					el('button', { style: busy === '' ? styles.button : styles.buttonBusy, onClick: scan, disabled: busy !== '' }, busy === t('scanning') ? t('scanning') : t('scan')),
					el('span', { style: styles.hint }, t('usage'))
				),
				error !== ''
					? el('div', { style: styles.err }, error)
					: null,
				sessions.length > 0
					? el('div', { style: styles.wrap },
						...sessions.map((row) => el('div', { key: row.session, style: styles.item },
							el('div', { style: styles.code }, row.session),
							el('div', { style: styles.hint }, `悬空=${row.dangling} · 图片=${row.images} · 文件=${row.files} · 占位=${row.placeholders} · ${row.workspace}`),
							el('div', { style: styles.row },
								el('button', { style: busy === '' ? styles.button : styles.buttonBusy, disabled: busy !== '', onClick: () => void run(t('busy'), '/repair', { session: row.session }) }, t('preview')),
								el('button', { style: busy === '' ? styles.danger : styles.buttonBusy, disabled: busy !== '', onClick: () => onWrite(row.session) }, pending === row.session ? t('confirm') : t('apply'))
							)
						))
					)
					: null,
				el('div', { style: styles.hint }, t('restart')),
				el('div', { style: styles.hint }, t('restoreHint')),
				el('div', { style: styles.row },
					el('input', {
						style: styles.input,
						value: backup,
						placeholder: t('backupPlaceholder'),
						onChange: (event) => setBackup(event.target.value),
					}),
					el('button', {
						style: busy === '' && backup !== '' ? styles.button : styles.buttonBusy,
						disabled: busy !== '' || backup === '',
						onClick: () => void run(t('busy'), '/restore', { session: sessions[0]?.session ?? '', backup, confirm: true }),
					}, t('restore'))
				),
				el('div', { style: styles.hint }, t('output')),
				el('pre', { style: styles.report }, report === '' ? t('none') : report)
			);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-attachment-repair: dictionaries');
			const bound = ctx.locale.bind(NS);
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'session-attachment-repair',
				order: 910,
				label: () => bound('nav'),
				locale: NS,
			}, RepairPage));
		}

		exports.inject = ['slots', 'locale'];
		exports.apply = apply;
		return exports;
	},
});
