# dsh-session-attachment-repair

修复 DSH（DeepSeek Harness）会话"能打开、历史也能看，但每次发消息都失败"的一类特定故障：会话历史引用过的图片或文件附件，其内容对象已经从本地附件库消失。

## 有什么用

每次发送消息都要重放整段历史。历史里只要有一个附件的对象文件不在了，请求就会在准备阶段中断——而失败文案往往只是兜底的 `... API stream from ... failed`，看起来像网络问题；换成别的模型通道，才会露出真实原因 `Attachment object is missing.`。

手工处理这件事容易踩三个坑，直接烧掉几个小时：

- **只改文件不重启**：服务端把已打开的会话留在内存里，改完不生效，复验得到假阴性；
- **改错日志格式**：会话日志是多帧 zstd 首尾相接，一次性解码只拿到第一帧，会误判"文件里只有几行"；
- **没有备份就覆盖**：会话日志是不可逆数据。

这个 Skill 把流程固定下来：先证明附件确实缺失，再备份、替换悬空引用、逐节点校验，最后要求重启服务端复验。

## 你会得到什么

- 一份可审计的判断：哪些会话受影响、悬空附件多少、图片与文件各几个；
- 修复后的会话日志 + 同位备份（`session.v3.jsonl.zstd.bak-<时间戳>`）；
- 逐节点校验报告：确认改动只发生在"悬空附件 → 文本占位"上，其余内容一字未动；
- 一条明确的下一步：重启服务端后复验，或回滚。

## 安装

### 让 Agent 安装（推荐）

把这个地址交给你的 Agent：

```text
https://github.com/chenkui-luo/dsh-session-attachment-repair
```

可以直接说一句：

```text
请帮我安装这个 Skill：https://github.com/chenkui-luo/dsh-session-attachment-repair
```

### 手动安装

1. 克隆或下载本仓库；
2. 把整个目录放到宿主的 skills 根目录（例如用户主目录下的 `.dsh/skills`）；
3. 目录名需与 `SKILL.md` 里的 `name` 一致。

如果你的宿主提供 skills CLI，通常也可以 `npx skills add chenkui-luo/dsh-session-attachment-repair`；本仓库在发布环境里没能联网实测这条命令，所以不把它作为主入口。

## 配置

无需额外配置，也不需要密钥或账号。

DSH 主目录默认取用户主目录下的 `.dsh`，可用环境变量 `DSH_HOME` 覆盖，或在命令里用 `--home <目录>` 指定。

## 使用

自然语言触发即可，例如：

- 「这个会话发不出消息了，帮我看看是不是附件丢了」
- 「把所有发不出消息的会话排查一遍」

主要入口：

```text
node scripts/repair_session.mjs scan                    # 扫描受影响的会话
node scripts/repair_session.mjs verify --session <id>   # 单个会话体检
node scripts/repair_session.mjs repair --session <id>   # 生成修复副本（不写入）
node scripts/repair_session.mjs repair --session <id> --apply   # 备份并写入
node scripts/repair_session.mjs restore --session <id> --backup <备份文件>
node scripts/repair_session.mjs self-test               # 编解码与备份链路自检
```

`verify` 在发现悬空附件时以退出码 1 结束，便于脚本判断。

## 以 DSH 插件方式使用

本仓库同时是一个 DSH 插件包（`dsh-plugin-session-attachment-repair`）。装上之后，「设置 → 会话附件修复」里就能扫描、预览、备份并写入，不用开终端：

```text
dsh plugin --profile web add github:chenkui-luo/dsh-session-attachment-repair
```

刷新页面一次，然后打开「设置 → 会话附件修复」。

没有 dsh CLI 时，把仓库放进 `<profile>/node_modules/dsh-plugin-session-attachment-repair`，并在 `<profile>/cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: session-attachment-repair
      name: 'dsh-plugin-session-attachment-repair'
```

插件只做转发：调用本仓库自己的 `scripts/repair_session.mjs`（`scan` / `repair` / `verify` / `restore`），把报告原样显示出来。写入与还原都要二次确认，备份由脚本负责；插件不重复实现修复逻辑，因此和 Skill 不会分叉。

本插件已登记到 [dsh-marketplace](https://github.com/chenkui-luo/dsh-marketplace) 的注册表（`registry/plugins/dsh-session-attachment-repair/plugin.json`）。

## 兼容性与依赖

| 维度 | 状态 |
| --- | --- |
| 宿主 | DSH 专用：依赖其会话日志与附件库格式 |
| 插件形态 | 需要宿主提供 `webServer` 与 `connection` 服务；客户端走 `settings.section` 插槽 |
| Windows | 已实际执行通过（扫描、修复、校验、备份、还原、自检、回归测试） |
| macOS / Linux | 未验证；脚本未使用平台专属命令，路径来自 `os.homedir()` 与参数 |
| Node.js | 需要 ≥ 22.15（`zlib` 的 zstd 同步编解码），缺失会直接报错退出 |
| 网络 | 不需要 |
| 宿主能力 | 需要会话目录的读写权限；重启服务端由用户亲自完成 |

DSH 升级后若会话日志格式或附件库布局变化，脚本的帧解析与路径约定需要同步更新。

## 数据与适用边界

- **数据不出本机**：不联网、不上传、不调用模型。
- **会修改会话日志**：不可逆操作，脚本强制先备份并比对哈希；写入后与副本再比对一次。
- **会改变历史显示**：被替换的附件在界面里显示为一行 `[图片已不可用：…]` 占位说明。
- **不能恢复图片内容**：附件库按内容哈希、字节数与宽高校验，原图拷回去会被判定为损坏。
- **不适用**：网络或代理问题、鉴权与余额、限流、上下文超长、模型配置错误，以及"对象存在但元数据不匹配"的损坏情况。

相邻能力：如果失败来自 DSH 版本升级带来的破坏性变更，走升级流程，不要套用本 Skill。

## 输出

- 扫描/体检：终端摘要，加 `--json` 输出结构化结果；
- 修复：临时目录中的修复副本；`--apply` 时生成同位备份并写回；
- 回滚：写回备份，并把回滚前状态另存一份。

## 测试

```text
node scripts/repair_session.mjs self-test   # 脚本内置自检
node tests/run_tests.mjs                    # 19 项回归测试（临时目录 + 合成会话）
```

静态校验用 oil-skill-creator 的 `validate_skill.py`，以 `--public --strict --weak-model` 运行；本 Skill 明确依赖宿主，因此不启用 `--universal`。

真实效果验证：修复后重启服务端并能成功发出一条消息，才算通过。

## 许可证

MIT
