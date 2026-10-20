# 论文工作台 · Paper Compare for ForX

一个独立的 Hermes-forX 统一插件包，同时提供 Desktop 侧栏页面和本机 Dashboard 页面。采用官方插件接口，不修改 Agent、聊天系统或桌面端核心文件。

包含现有论文工具的完整功能：MinerU 解析、本地论文库、多模型流式对照、长输出续写、按模型隔离的连续追问、原文段落与 PDF 高亮、图表和公式局部精读、统一证据记录、按证据缺口补查、笔记与离线报告导出。默认回答模型仍为 `k3` 和 `glm-5.3`。

账号登录、模型提供商、API 地址、凭据池和自定义接口的附加请求头均复用 ForX 的原有配置与凭据解析器。插件中的设置按钮直接打开 ForX 的“账号与模型”，无需再填一份模型密钥。

## 安装

需要 ForX 的 Python 环境、Node.js 22.13+、Poppler，以及可用的模型网关和 MinerU 服务。插件运行依赖已在 `runtime/package-lock.json` 锁定。

在仓库根目录运行：

```bash
python plugins/paper-compare/install.py
```

安装脚本默认复制完整插件到当前 ForX home 的 `plugins/paper-compare`，在该档案内保留 Node 可执行文件和 npm 运行依赖，备份并更新 `config.yaml`，启用 Agent 端。安装完成后，下载目录、开发仓库和旧独立版目录均不再是运行依赖。默认 home 由 ForX 的 `get_hermes_home()` 解析，也可显式传入 `--home /path/to/forx-home`。已有依赖的离线开发包可使用 `--skip-deps` 复制依赖；只有显式 `--link` 才会建立开发符号链接。

随后重新启动 ForX 后端，在 **Capabilities → Plugins** 中打开“论文工作台”的 Desktop 开关，点击侧栏的“论文工作台”。Desktop 半包使用官方统一插件发现和热重载机制。也可在命令面板搜索“打开论文工作台”。本机 Dashboard 对应 `/papers` 页面。

迁移已有独立版数据时，先等待任务完成并停止占用旧库的论文服务，再运行：

```bash
python plugins/paper-compare/migrate.py --source /path/to/paper-compare/.paper-data
python plugins/paper-compare/install.py
```

迁移器先在所属档案的 `backups/paper-compare/<时间戳>/` 中备份原配置、完整论文文件和 SQLite 一致性快照，逐表校验记录与引用、逐文件核对 SHA-256，再把已验证的副本原子发布到 `plugin-data/paper-compare/library`。原库保留，不重新解析论文、不改写回答和引用编号；目标库已存在或旧服务仍在使用源库时会拒绝覆盖。浏览器偏好命名空间也随库保留。迁移成功才切换配置，失败则保留原库和备份。

迁移会将外部视觉检测报告复制进新库，并将旧解析配置中允许的 MinerU/Poppler 项复制到档案内的私有 `parser.env`；旧模型密钥不会复制。安装器将旧代码包和配置备份到 `backups/paper-compare-install/<时间戳>/`，然后发布完整副本。论文数据与插件代码分开，后续升级代码不会覆盖论文库。

数据库快照在 SQLite 一致性备份完成后转换为独立的单文件日志格式，恢复和只读校验不需要旁边存在 WAL/SHM 文件；活动源库继续保留自己的运行日志模式。

一个配置档案的正常目录结构为：

```text
<ForX 配置档案>/
  plugins/paper-compare/                 # 独立插件、前端、Node 依赖
  plugin-data/paper-compare/
    library/                            # SQLite、原论文和缓存
    runtime/node/                       # 本档案自己的 Node 运行时
    port.json                           # 稳定的本机端口
    service.log
  backups/paper-compare/                 # 论文迁移备份与校验清单
  backups/paper-compare-install/         # 代码更新与配置备份
```

## 配置与隔离

非密钥设置保存在所属配置档案的 `config.yaml`：

```yaml
plugins:
  enabled: [paper-compare]
  entries:
    paper-compare:
      settings:
        node_path: plugin-data/paper-compare/runtime/node/bin/node
        pdf_parser: mineru
        mineru_base_url: http://127.0.0.1:8000/v1
        # 默认库位于本档案的 plugin-data/paper-compare/library
```

模型接口统一在 ForX → 设置 → 账号与模型中配置。插件调用 `hermes_cli.runtime_provider.resolve_runtime_provider()`，在当前配置档案的 home 与 secret scope 内解析已登录的账号或 API 提供商，沿用 ForX 自己的凭据刷新机制。插件原有的 `base_url`、`LLM_BASE_URL` 和 `LLM_API_KEY` 不再参与模型凭据选择，浏览器修改模型密钥的接口也会被拒绝。

每次发起问答、续写、核验、局部精读或刷新模型列表前，后端通过父子进程的私有管道重新读取 ForX 配置；切换接口、重新登录和退出登录无需重启论文服务。已经开始的任务在整个自动续写流程中保留自己的配置快照，防止中途串用另一个账号；新任务使用新的登录状态。退出登录后仍可阅读本机论文、历史问答和笔记。不会因打开论文页面而新建匿名账号。

当前论文运行时使用 Chat Completions 协议。ForX 的 New API 登录和兼容此协议的 API 提供商可直接使用；当选中的提供商需要原生 Messages、Responses 或外部进程协议时，界面会提示在 ForX 中选择兼容接口，不会把其凭据发往另一个默认网关。

MinerU 仍是独立的解析服务，在插件 settings 中配置 `pdf_parser`、`mineru_base_url`、`mineru_tier`，如需认证则在所属配置档案的私有 `.env` 配置 `MINERU_API_KEY`。迁移独立版时，`--env-file` 仅复用 `MINERU_*`、`PDF_PARSER` 与 Poppler 路径，不读取其中的模型密钥。所有模型凭据和附加认证头只留在服务端，不进入浏览器、论文数据库、导出文件或子进程命令行。视觉检测和转录缓存按接口、凭据与模型作用域区分，保留原有记录。

每个 ForX 配置档案拥有独立服务和默认论文库 `plugin-data/paper-compare/library`。只有显式指定的 `data_dir` 才会复用外部库。服务以请求所属 home 读取配置与密钥，不借用其他档案的环境变量。ForX 聊天记录不自动加入论文问答；论文内部各模型仍只收到自己的历史回答。

## 运行方式

- 打开页面后按需启动 Node 服务；重复进入页面复用同一服务，不重复模型调用。
- 服务只监听 `127.0.0.1`：首次自动分配端口，此后从配置档案的 `plugin-data/paper-compare/port.json` 恢复端口，保持浏览器偏好与草稿的来源稳定；每次启动重新生成随机访问路径。浏览器存储另按所属 home 和数据目录隔离。ForX 的认证 REST 接口返回该本机入口，模型密钥始终在服务端。端口被其他应用占用时明确报错，可在插件 settings 中设置另一个 `port`。
- API、SSE、图像、公式字体和导出资源均遵循工作台所在的基础路径；保留原有 Host、Origin、CSRF 检查。只有本机 Desktop 和 Dashboard 可嵌入工作台。
- 关闭页面不取消生成；关闭后端时保存已生成片段，退出子服务；重启后按原工具逻辑恢复记录。后端异常退出时，子服务检查父进程并退出，下一次启动回收失效锁。
- 当前接入面向**本机桌面工作流**。远程 ForX 后端和 HTTPS 远程 Dashboard 不使用此本机 iframe 接入方式。

`forx paper doctor` 可检查 Node、Poppler 和运行依赖。启动失败的简短日志位于所属 home 的 `plugin-data/paper-compare/service.log`。

## 维护与验证

`runtime/` 是插件自带的完整源代码，后续功能开发可直接在这里维护，无需旧工具目录。在仓库根目录运行：

```bash
npm ci --prefix plugins/paper-compare/runtime --ignore-scripts
npm run check --prefix plugins/paper-compare/runtime
npm test --prefix plugins/paper-compare/runtime
scripts/run_tests.sh tests/plugins/test_paper_compare_plugin.py tests/plugins/test_paper_compare_storage.py -j 1
```

`sync-runtime.mjs` 仅是可选的开发导入工具，必须显式传入源目录，不在安装或运行时调用。分发完整插件包后，在目标机器运行 `install.py` 即可获得独立副本。Poppler 是本机 PDF 页面渲染工具；MinerU 与模型网关是配置的解析/推理服务，插件按需调用它们，无需单独启动旧论文工具的服务。

集成测试通过真实插件发现、ForX 原有的登录凭据存储与提供商解析器、真实本机 Node 服务、两个临时 ForX home 和本地模拟模型网关验证 A→B→A 数据与密钥隔离、登录密钥轮换、退出后阻止新调用、接口地址变更、自定义 API 附加请求头、SSE、按模型追问和重启恢复。原工具的回归测试继续覆盖续写、引用、图表精读、证据核验、LaTeX 和导出。
