# 船期数据工作台 · DeepSeek Harness 插件

把公众号资讯、船期表对比、轨迹合理性检测、邮件附件收成一张工作台。装进 DeepSeek Harness 后,
侧栏底部出现「船期工作台」,点开是全屏界面。模型能力直接用 DSH 里已选好的默认模型,不需要另外配 API Key。

- **公众号**:输入名称自动找出 biz / 合集,按间隔采集文章
- **AI 热点**:每天 07:00 自动整理一份「当天的热点条目列表」(取截至当天的近 7 天素材),
  按日期落盘,可回看历史;没有模型或没有素材时如实给出原因
- **轨迹检测**:上传轨迹导出表 → 段天数规则 + 塞港等泊数据 + DSH 模型判定 →
  标红导出,并单独列出「需要提醒的不合理点」;航段 ≤ 1 天的可疑点不提醒
- **船期对比**:自动把同一封邮件系列里最近两版附件配成「旧 → 新」一行,有对比结果直接打开;
  没有结果点「对比」现场跑(自动做表头映射 + AI 复核);结果页和配对行都有「重新对比」,
  用留存的源文件重跑一遍;也支持上传新旧两份文件手工对比(excel / 文本型 PDF)
- **邮件**:IMAP 收件,每天 06:30 自动拉取,excel / pdf 附件按船东入版本并自动对比
- **塞港**:从 CargoAct 接口拉全量港口拥堵数据,也可手工导入表格

## 安装

**方式一(推荐,DSH 插件管理器)**:设置 → 插件 → 安装

```
github:<你的账号>/shipping-workbench
```

**Windows 注意**:用 `github:` 安装需要本机有 `git`。没有会报
`[ERR_PNPM_GIT_RESOLVE_FAILED] ... 'git' 不是内部或外部命令`。两条路:

1. 装 Git for Windows(`winget install --id Git.Git -e` 或 https://git-scm.com/download/win),
   **重开 PowerShell 确认 `git --version` 能跑,再重启 DeepSeek Harness**,然后重试安装;
2. 不想装 git:下载仓库 zip(`https://github.com/jacksonw111/shipping-workbench/archive/refs/heads/main.zip`),
   解压后到 **设置 → 插件 → 添加插件** 选这个目录(包根目录有 `package.json`),不需要 git。

**方式二(本地)**:终端里执行

```bash
cd 这个目录
./install.sh
```

安装脚本会把插件复制到 `~/.dsh/profiles/<profile>/plugins/shipping-workbench`,
写进 profile 的 `dependencies(file:)`,并在 `cordis.patch.yml` 追加一条 `insert` 条目。
装完**重启 DeepSeek Harness** 生效(desktop profile 的插件补丁不热加载)。

卸载:执行 `./uninstall.sh`;数据目录 `~/.dsh/shipping-workbench/` 不会被删。

> 自己重新打包需要 Node 20+;运行时不需要,依赖已经打进 `lib/index.js`。

## 手工对比可以导入 Skill,让模型按规则对比

船期对比页的「手工对比」除了内置对比键,还支持导入**技能包**让模型按 Skill 自己对比。

技能包是一个 zip(和常见 Skill 约定一致):

```
panda-skill.zip
├── SKILL.md                 # 必需:front-matter(name/description)+ 对比规则
├── references/rule.md       # 可选:参考资料(.md/.txt/.csv/.json/.yaml),会一起给模型
├── notes/readme.txt
└── scripts/panda_compare.py # 可选:脚本,只列清单、不执行
```

流程:选旧版/新版 → 「对比 Skill」导入 zip(也兼容单个 `.md`) → 按钮变成
「用 Agent 按 Skill 对比」。

两种执行方式(取其一):

1. **跑技能脚本(推荐,包内有 scripts/ 时默认执行)**:用
   `<解释器> scripts/xxx.py|mjs <旧版> <新版> --out <run>/out/result.xlsx` 直接跑,
   产物文件出现在结果页并可下载——**输出格式完全由 Skill 的脚本决定**。
   环境变量 `SKILL_OLD_FILE` / `SKILL_NEW_FILE` / `SKILL_OUT_DIR` 也会给到脚本。
   不想执行可以取消勾选;此时结果页会明确提示「脚本被跳过,模型结果是推断的」。
2. **模型按 Skill 对比(没有脚本时)**:把 SKILL.md + 参考资料 + 两份表交给模型,
   要求它按 Skill 规定的格式写 `report`(Markdown),结果页直接渲染;
   同时仍可给出结构化的增删改条目。

数据保真:表格行**带 `(隐藏)` 标记**(Skill 常按 Excel 隐藏行剔除航线),
默认每表 600 行 / 6 个 sheet / 12 万字符;超出会截断并在结果里标注。

加载时做这些事:

- 安全解包:过滤绝对路径与 `..`,单包上限 10MB;
- 找 `SKILL.md`(包内最浅的一份),支持 front-matter 或一级标题命名;
- 参考资料(单份 8k / 合计 30k 字符)随提示词给模型,文件清单与脚本清单一并告知;
- **脚本不执行**——只按 SKILL.md 与参考资料判断(要执行上传脚本需要单独开关,默认关闭);
- 解包内容留档在 `~/.dsh/shipping-workbench/schedule/skills/<hash>/`,可追溯。

结果:摘要、新增/删除/变更统计、本次用到的规则、逐行差异
(工作表 / 对比键 / 结果 / 字段 / 旧值 → 新值 / 说明),可导出 xlsx。
系统提示词要求模型「Skill 规则优先于自身经验」;数据超长会截断并在摘要里说明;
没有模型时接口返回可读的 400,不伪造结果。

## 邮件拉取是增量的

每次拉取先用一次便宜的 `SEARCH` 拿 UID 列表,只对**还没入库**的那几封下载整封正文和附件,
已入库的不再重下;附件识别也只跑这一轮新入库的邮件。

- 之前:每次重下最近 40 封(实测 15.3MB / 19.5 秒),其中附件 10.8MB
- 现在:无新邮件约 1.3 秒(只连接+搜索,0 字节下载);有 3 封新邮件约 2.2 秒

返回里带 `timings`(connect / login / select / search / fetch / store / total),界面的
提示也会显示本轮耗时,慢的时候能直接看出卡在哪一段。

## 内网 npm 安装(推荐给同事)

包发布在 GitLab 项目级 npm Registry:

```
@internal-tools/shipping-workbench
```

**1. 配 registry 与只读 token**(一次性)。在 `~/.dsh/profiles/desktop/.npmrc` 写入:

```ini
@internal-tools:registry=https://git.witranscn.com/api/v4/projects/11/packages/npm/
//git.witranscn.com/api/v4/projects/11/packages/npm/:_authToken=<npm-read token>
```

token 是项目里 `Settings → Repository → Deploy tokens` 的 **npm-read**
(scope `read_package_registry`,只读、不能改代码)。同事不需要 GitLab 账号,有 token 就能装。

**2. 在 DSH 里安装**:设置 → 插件 → 安装,填

```
@internal-tools/shipping-workbench
```

然后重启 DeepSeek Harness。

**3. 升级**:

```bash
npm view @internal-tools/shipping-workbench version   # 看最新
# DSH 里重新安装 @internal-tools/shipping-workbench@latest,或:
cd ~/.dsh/profiles/desktop && pnpm update @internal-tools/shipping-workbench
```

再重启一次(后端代码启动时加载)。

**4. 发新版本**(维护者):

```bash
GITLAB_HOST=git.witranscn.com \
GITLAB_PROJECT=internal-tools/shipping-workbench \
GITLAB_TOKEN=<有 write_package_registry 的 token> \
node scripts/publish-gitlab-npm.mjs --version 0.13.0
```

脚本会:校验 Package Registry 已开启 → 复制发布目录并把包名改成 scoped →
同步 `cordis.patch.yml` 的 `name` → `npm pack` + `npm publish`。
发布后把版本号加在安装命令里即可(`@internal-tools/shipping-workbench@0.13.0`)。

## 跟随更新

插件装进 profile 的是一份**副本**,不跟 git;更新分两层:

| 改了什么 | 生效方式 |
|---|---|
| 只改了 `ui/`(界面、文案、交互) | 覆盖文件后**刷新页面**即可 |
| 改了 `src/`(路由、定时器、领域逻辑,即 `lib/index.js`) | 必须**重启 DeepSeek Harness** |

两种更新方式:

1. **工作台里**:设置 → 版本与更新 → 「检查更新」→「一键更新」。
   会下载 GitHub 上的最新版本、备份当前版本到 `~/.dsh/shipping-workbench/plugin-backup/`,
   后端有变化时明确提示需要重启。
2. **命令行**:

```bash
./update.command            # 检查并更新
./update.command --check    # 只看有没有新版本
./update.command --restart  # 更新完自动重启应用
```

更新源默认 `jacksonw111/shipping-workbench` 的 `main` 分支,可在
`~/.dsh/shipping-workbench/settings.json` 的 `update` 段覆盖(`owner` / `repo` / `branch`)。

## 配置

打开工作台 → 设置:

| 区块 | 必填 | 说明 |
|---|---|---|
| 公众号 | — | 输入名称即可,其余字段自动补 |
| 邮件 | IMAP 服务器 / 账号 / 密码 | 默认 `imap.exmail.qq.com:993`(腾讯企业邮),换成自己邮箱服务商的 IMAP 即可 |

口令只写在 `~/.dsh/shipping-workbench/settings.json`(0600),接口只回 `••••`。
也可以用环境变量注入:`SHIPPING_MAIL_PASSWORD`、`SHIPPING_MAIL_USER`。

### 公众号采集:通道分工与失败处理

| 通道 | 什么时候用 | 失败怎么办 |
|---|---|---|
| **合集**(主) | 有 `album_id` 时每轮都抓 | 网络/502 自动重试一次;命中风控则全局冷却 30 分钟 |
| **搜狗**(补充) | 没有合集,或合集断更超过 **24 小时** | 命中风控冷却 **6 小时**(跨进程保存);平时不再每轮去撞 |

几条硬规则:

- **风控是冷却,不是失败**。429 只记一条提示,不会把账号标成 `failed`;只有「所有真正尝试过的通道
  都硬失败」才判失败。
- **单篇文章抓取失败只记提示**,同一轮其它文章照常入库。
- 账号状态只有三种:`ok` / `partial`(部分通道出错)/ `failed`;账号行会显示原因与冷却提示。
- 合集接口带 `begin_msgid` 翻页,遇到「环境异常/验证码」按风控处理,不去硬刚。

对应设置项(设置 → 公众号):`sogouFallbackHours`(合集断更多久才试搜狗,默认 24)、
`sogouCooldownHours`(搜狗风控冷却,默认 6)、`albumCooldownMinutes`(合集风控冷却,默认 30)。

### 邮件服务商注意

- 先在邮箱网页版开启 **IMAP/SMTP 服务**;
- 开通了「安全登录」的账号要生成**客户端专用密码**,填进工作台的密码框,而不是网页登录密码;
- 工作台里的「自动探测」会尝试常见域名并纠正填错的 IMAP 服务器;
- 「SMTP 检查」用来区分两类失败:SMTP 也认证失败 = 账号/密码不对;SMTP 通过但 IMAP 被拒 = 邮箱没开 IMAP。

### 模型判定不需要额外配置

轨迹检测的「DSH Agent 判定」、船期表结构识别、热点整理,都走 DSH 当前选中的默认模型
(`ctx.llm` + `agentDefaultModel`);没挂模型时界面会直接说明原因,不会伪造结果。

### 轨迹检测的模型判定(先筛后判,不是全量猛调)

轨迹表 1 万多行、1 千多个 Rotation,全量逐组调用模型既慢又贵,大部分航段本来也没有疑点。
现在的顺序是:

1. **规则层**先跑:累计回退、缺字段、闭环超额直接判红;
2. **塞港层**:等泊明显长于航段的段判冲突(≤1 天的按业务口径不提醒);
3. **按判定范围决定送哪些组**(设置 → 判定范围):
   - `只判疑点`(默认):规则硬错 + 塞港冲突全收,再补最慢的 120 个航段,上限 400 组;
   - `全量送模型`:1,403 个有效组全部送模型,覆盖 100%;
4. **按字符预算打包**:一次请求 3 万字符、最多 12 次请求,而不是「每组一次」。

真实数据实测(11,075 行 / 1,705 组,其中未关联船队跳过 302 组 / 2,078 行):

| 范围 | 送模型 | 覆盖行数 | 请求数 |
|---|---|---|---|
| 旧行为(只判前 40 组) | 40 组 | 322 / 8,997(3.6%) | 10 |
| 只判疑点(默认) | 150 组 | 1,584 / 8,997(17.6%) | 约 8 |
| 全量送模型 | 1,403 组 | 8,997 / 8,997(100%) | 约 44(预算调到 6 万字符则约 22) |

**组内的每一行都会完整送进 prompt**(排序、港口英文、五字码、累计天数、航向、码头,加逐段天数和
同类港口对历史),不做抽样;没被选中的组由规则层和塞港层照常判定。结果页会显示
「候选数 · 请求次数 · 覆盖行数」,截断也会如实标出。

判定提示词在**设置 → 轨迹判定提示词**里完整展示,可以直接改;改完保存即生效,
点「恢复默认」回到内置版本。清空即使用默认。

### AI 在船期对比里做什么(全自动)

对比本身是确定式的:解析 → 键匹配 → 逐格 diff,AI 不参与逐行判定,所以结果可复现、不飘。
模型只在三个地方补人做不到的事:

1. **自动表头映射**:两份文件的键列/开航日期列对不上时,直接把表头和样例数据交给模型,
   让它给出「标准字段 → 这版列名」的映射,按「表头 + 模型」缓存后自动套用;结果页顶部会显示
   「AI 识别表头」和每个字段对应的真实列名。
2. **自动复核**:对比出变更后,把变更清单(含旧 → 新)交给模型逐条判断是**真实变更**还是
   **解析噪声**(空格/换行/全半角/日期格式等价/拆行拼接)。结果页给出「真实 / 噪声」数量与逐条理由。
3. **中文摘要**:把统计和变更明细写成 3–5 句,给运营看。

没有模型、调用失败或返回坏 JSON 时全部静默降级:映射不套用、复核按「全部真实」兜底、摘要留空,
对比结果本身永远不受影响。

### 塞港数据

直接从 CargoAct 的公开拥堵接口拉全量港口数据,按 `Code`(五字码)匹配轨迹里的港口;
等泊天数从 `Comment` 里的 "around N days" 解析,没有就留空,不猜。
数据超过 12 小时会在插件启动后自动刷新,也可以在「塞港」页手动抓取或导入自己的表。

## 数据落在哪

```
~/.dsh/shipping-workbench/
├── workbench.db            SQLite:公众号、文章、任务记录、船东配置、塞港数据
├── settings.json           配置(含口令,0600)
├── hotspots/reports/       每天一份热点列表(YYYY-MM-DD.json)
├── track/runs/<id>/        每次轨迹检测的源文件、结果、导出
├── schedule/runs/<id>/     每次船期对比的旧版/新版与结果
└── mail/                   邮件索引与附件
```

`workbench.db` 用 Node 内置的 `node:sqlite`,不装原生依赖。
表:`mp_account`、`mp_article`、`compare_run`、`carrier`、`carrier_version`、`congestion_port`、`app_flag`。

## 开发

```bash
npm install
npm test                       # 解析 / 对比 / 导出 / HTTP / MIME / PDF / 客户端包
npm run build                  # 打包 host 到 lib/index.js,复制客户端到 lib/client.js
node scripts/dev-server.mjs --port 18990   # 不装进 DSH 也能看界面
# http://127.0.0.1:18990/shipping-workbench/
```

源码布局:

```
src/index.js           插件入口(注册 HTTP 路由 + 定时器)
src/hosting/router.js  静态站 + JSON API
src/domain/            公众号 / 热点 / 轨迹 / 船期 / 邮件 / 塞港 / PDF / xlsx
client-src/client.js   浏览器半:侧栏入口 + 全屏 iframe
ui/                    工作台前端(无构建,原生 ES 模块)
```

## 已知边界

- 公众号抓取依赖微信公开页面与搜狗检索;命中风控会整次中止并记录原因,不会静默采 0 篇。
- 轨迹检测规则层只抓硬错(累计回退、缺字段、塞港时间不够);「多少天算不合理」交给 Agent,
  航段 ≤ 1 天的可疑点按业务口径不提醒。
- 船期对比支持 excel 与**文本型 PDF**:PDF 按文本坐标还原成表格,扫描件会如实报
  「没有可提取的文字」;压缩包(如 MSC 的 zip)还没接入。船东专有版式(PANDA/Matson/ZIM 等)
  的语义差异由 DSH 模型做列映射,不写死解析规则。
