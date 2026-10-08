/**
 * The panel's domain model: the phase vocabulary, the record/bug/loop shapes,
 * the built-in rule tables, and the pure builders that turn all of it into the
 * text a session receives.
 *
 * Split out of the view because the loop no longer lives in the view: the
 * controller (root scope) drives the same builders the panel previews, so both
 * must read one definition. Nothing here touches React, services or storage.
 */
import {
  jsonContract, type ParsedBug, type ParsedFixOutcome, type ParsedRequirement,
} from './loop-protocol.ts'

/** One lifecycle phase of the xgg-cycle menu. */
export interface Phase {
  id: string
  label: string
  description: string
}

/** One feature point (priority + name + description). */
export interface FeaturePoint {
  name: string
  priority: 'P0' | 'P1' | 'P2'
  description: string
  /** Set when a 开发 round reported this point as implemented. */
  done?: boolean
  /** Epoch millis of that report. */
  doneAt?: number
  /** The 原型 version the implementing round was built against. */
  doneVersion?: number
}

/** A module containing its own feature points. */
export interface ModuleGroup {
  id: string
  name: string
  points: FeaturePoint[]
}

/** A manually added requirement carrying its candidate expansion (grouped). */
export interface Requirement {
  id: string
  text: string
  expanded: boolean
  modules: ModuleGroup[]
  /**
   * Expansion in flight. Kept here rather than in the component because the
   * dispatch selects its session, which unmounts the session-scoped copy of
   * the panel — component state would vanish mid-request and the button would
   * silently fall back to its idle label.
   */
  expanding?: boolean
  /** Why the last expansion attempt failed, for the same reason. */
  error?: string
}

/** Confirmed feature points of one requirement (grouped, then split by module). */
export interface RequirementGroup {
  reqId: string
  reqText: string
  modules: ModuleGroup[]
}

/** A free-form key/value info field. */
export interface InfoEntry {
  id: string
  key: string
  value: string
}

/** Draft for adding a single feature point into a module. */
export interface NewPointDraft {
  name: string
  priority: 'P0' | 'P1' | 'P2'
  description: string
}

const DEFAULT_POINT_PRIORITY: FeaturePoint['priority'] = 'P2'

/** Empty feature-point editor value. */
export const EMPTY_POINT_DRAFT: NewPointDraft = { name: '', priority: DEFAULT_POINT_PRIORITY, description: '' }

/** The ordered lifecycle phases driving the left menu. 基础信息 leads. */
export const PHASES: readonly Phase[] = [
  { id: 'info', label: '基础信息', description: '项目级基础信息：技术选型、框架、环境等 key/value 配置。' },
  { id: 'requirement', label: '需求', description: '收集和整理需求：目标、范围、约束与验收标准。' },
  { id: 'feature', label: '功能点', description: '按需求归类、按模块分组的功能点清单。' },
  { id: 'prototype', label: '原型', description: '选定交付类型，把基础信息、需求、功能点与内置开发约定交付给一个新会话。' },
  { id: 'develop', label: '开发', description: '在原型那个会话里继续，把原型做成可上线的完整工程。' },
  { id: 'test', label: '测试', description: '先让会话自动测一轮并列出问题，也可以自己手动提 bug 一起带过去。' },
  { id: 'release', label: '上线', description: '选部署方式：Cloudflare 测试部署，或给出账号密码 SSH 直连服务器。' },
]

/** The delivery shape the prototype session is told to produce. */
export type PrototypeMode = 'simple' | 'full'

/** Where one hand-off stands. Set to 进行中 on send; the user revises it after. */
export type HandOffStatus = 'active' | 'done' | 'dropped'

/** Status vocabulary in picker order. */
export const HANDOFF_STATUSES: readonly { id: HandOffStatus; label: string }[] = [
  { id: 'active', label: '进行中' },
  { id: 'done', label: '已完成' },
  { id: 'dropped', label: '已作废' },
]

/**
 * How many test/fix rounds the automatic loop may run before it stops on its
 * own. A backstop, not a target: without it a model that keeps finding new P2s
 * would spin indefinitely.
 */
export const MAX_FIX_ROUNDS = 5

/** Where the automatic loop currently stands. */
export type LoopStage =
  | 'idle' | 'expanding' | 'prototyping'
  | 'developing' | 'testing' | 'fixing' | 'done' | 'failed' | 'stopped'

/** Stages during which a turn is in flight (nothing else may be dispatched). */
export const BUSY_STAGES: readonly LoopStage[] = ['expanding', 'prototyping', 'developing', 'testing', 'fixing']

/** One line in the loop's progress log. */
export interface LoopStep {
  id: string
  label: string
  status: 'running' | 'ok' | 'failed'
  detail: string
  at: number
}

/** The automatic loop's whole observable state. */
export interface LoopState {
  stage: LoopStage
  /** Current test/fix round (1-based); 0 before the loop reaches them. */
  round: number
  steps: LoopStep[]
  /** The project session the loop is driving. */
  sessionId: string
  /** The 原型 version this run produced. */
  version: number
  /** Human-facing status line. */
  message: string
}

/** Automatic-loop state before a run starts. */
export const IDLE_LOOP: LoopState = {
  stage: 'idle', round: 0, steps: [], sessionId: '', version: 0, message: '',
}

/** Where a release round is aimed. */
export type ReleaseTarget = 'cloudflare' | 'server'

/** One offered release target: its picker copy and the rules it contributes. */
export interface ReleaseTargetSpec {
  id: ReleaseTarget
  label: string
  hint: string
  rules: readonly string[]
}

/** The default target — a throwaway test deploy, no credentials involved. */
export const CLOUDFLARE_TARGET: ReleaseTargetSpec = {
  id: 'cloudflare',
  label: 'Cloudflare（测试用）',
  hint: '直接部署到 Cloudflare，拿一个可访问的预览地址，不碰生产数据。',
  rules: [
    '部署目标：Cloudflare。纯前端项目用 Cloudflare Pages；带后端接口的用 Pages Functions 或 Workers，数据按需要选 D1/KV，并说明为什么这么选。',
    '用 wrangler CLI 完成部署：给出 wrangler.toml（或 Pages 侧配置）、需要执行的命令，以及 wrangler login 和 API Token 两种登录方式的步骤。',
    '.env.example 里的每一项在 Cloudflare 侧对应怎么配（wrangler secret put 或面板环境变量）逐项说明；真实密钥不要写进仓库，也不要出现在提交记录里。',
    '这是测试环境：不要连生产数据，用 mock 或测试数据即可；项目还在用前端 mock 就把 mock 一起部署上去，不要为了上线临时去接真实后端。',
    '部署完成后给出可访问的预览 URL，并列出验收路径 —— 打开哪些页面、点哪些操作能确认这次部署是成功的。',
    '附上回滚方式与重新部署的命令。',
  ],
}

/** The direct target: SSH onto a machine the user owns and stand the app up. */
export const SERVER_TARGET: ReleaseTargetSpec = {
  id: 'server',
  label: '服务器直连',
  hint: '给出 IP、账号密码与部署目录，直接 SSH 上去部署。',
  rules: [
    '部署目标：下面【服务器连接信息】里的那台机器，通过 SSH 直连操作。',
    '先探活再动手：确认能连上、确认系统版本与已装运行时（Node、包管理器、数据库、nginx），缺什么先装什么，每一步都说清楚在做什么。',
    '把项目部署到指定目录：拉代码或上传代码、安装依赖、按生产模式构建。',
    '服务常驻用 pm2 或 systemd（说明选了哪个、为什么），配置开机自启；前端用 nginx 提供静态文件并反代后端接口。',
    '按 .env.example 在服务器上创建并填好 .env，文件权限收紧；真实密钥只留在服务器上，不要回写进仓库。',
    '只开放必要端口，并说明防火墙具体改了什么。',
    '部署完成后给出访问地址、验收路径、查看日志的命令，以及回滚步骤。',
  ],
}

/** The offered targets in picker order; Cloudflare leads as the safe default. */
export const RELEASE_TARGETS: readonly ReleaseTargetSpec[] = [CLOUDFLARE_TARGET, SERVER_TARGET]

/** SSH connection fields. The password is intentionally absent — see SERVER_STORAGE_KEY. */
export interface ServerConfig {
  host: string
  port: string
  user: string
  path: string
}

/** Empty server deployment form with the conventional SSH port. */
export const EMPTY_SERVER: ServerConfig = { host: '', port: '22', user: '', path: '' }

/** Where one filed problem stands. Revised freely, like a hand-off status. */
export type BugStatus = 'open' | 'fixing' | 'fixed' | 'wontfix'

/** Bug status vocabulary in picker order. */
export const BUG_STATUSES: readonly { id: BugStatus; label: string }[] = [
  { id: 'open', label: '待修复' },
  { id: 'fixing', label: '修复中' },
  { id: 'fixed', label: '已修复' },
  { id: 'wontfix', label: '不修复' },
]

/** One problem the user filed by hand in the 测试 phase. */
export interface BugItem {
  id: string
  title: string
  detail: string
  /** Same three-tier vocabulary the feature points use. */
  severity: FeaturePoint['priority']
  status: BugStatus
  createdAt: number
  /** What the last fix round concluded about it. */
  note?: string
}

/**
 * Whether a problem is still open work.
 *
 * The single definition of "worth dispatching": it gates the tick boxes, the
 * problems that ride a 测试 round, and the ones a 修复 round may carry. A
 * settled problem that slipped into a dispatch would contradict its own label —
 * asking to fix what is marked 已修复, or what the user decided not to fix.
 * @param bug - the problem.
 * @returns true while it still needs work.
 */
export function isActionableBug(bug: BugItem): boolean {
  return bug.status === 'open' || bug.status === 'fixing'
}

/**
 * One dispatched hand-off, kept so the phase can list what was sent, which
 * version it was, and where it stands.
 */
export interface HandOffRecord {
  id: string
  kind: 'prototype' | 'develop' | 'test' | 'fix' | 'release'
  /** 原型: its own version. 开发/测试: the round number against `baseVersion`. */
  version: number
  /** 开发/测试 only: the 原型 version this round builds on. */
  baseVersion?: number
  /** 原型 only: the delivery shape it asked for. */
  mode?: PrototypeMode
  /** 上线 only: where the round was aimed. */
  target?: ReleaseTarget
  /** Epoch millis of dispatch. */
  createdAt: number
  /** The session the message landed in. */
  sessionId: string
  status: HandOffStatus
  /** What settling this round did, shown on the row (bugs harvested, report unparsable…). */
  note?: string
  /**
   * The message as sent — with one exception: an SSH password is stored
   * masked. The archive lives in localStorage, which is no place for a
   * credential, and a redacted archive is still enough to see what was asked.
   */
  content: string
}

/** One offered delivery shape: its picker copy and the rules it contributes. */
export interface PrototypeModeSpec {
  id: PrototypeMode
  label: string
  hint: string
  rules: readonly string[]
}

/** The default shape — also the fallback when a stored mode no longer resolves. */
export const SIMPLE_MODE: PrototypeModeSpec = {
  id: 'simple',
  label: '简易项目',
  hint: '单个 HTML 文件，双击就能打开，用来快速看界面和流程。',
  rules: [
    '交付形态：单个 HTML 文件，CSS 与 JS 全部内联，双击即可在浏览器打开，不需要任何构建步骤，不产生 node_modules。',
    '依赖只允许通过 CDN <script> 引入（Vue 3 用 CDN 全局构建版即可），不使用打包器，不使用 .vue 单文件组件。',
    '多个页面在同一个文件内用视图切换实现，不引入路由库。',
  ],
}

/** The engineered shape: a real project the user can keep building on. */
export const FULL_MODE: PrototypeModeSpec = {
  id: 'full',
  label: '完整项目',
  hint: '完整的 Vue 3 工程化项目，可以直接在上面继续往下做。',
  rules: [
    '交付形态：完整可运行的 Vue 3 工程化项目 —— Vite + TypeScript + Vue Router + Pinia，UI 组件库优先选 Element Plus。',
    '按模块划分目录：src/views 下每个功能模块一个子目录，src/components 放复用组件，src/router 与 src/stores 各司其职。',
    'mock 数据集中放在 src/mock/，并只通过 src/api/ 这一层封装对外提供；将来换真实接口时只改 src/api/，页面代码不动。',
    '给全 package.json、vite.config.ts、tsconfig.json 与 README，README 写明 pnpm install / pnpm dev 的启动步骤。',
    '逐个文件把代码写完整，不要出现「此处省略」「同上」「略」之类的占位。',
  ],
}

/**
 * The offered shapes in picker order. Shape rules lead the 开发约定 block
 * because they decide the file layout every later rule is written against.
 */
export const PROTOTYPE_MODES: readonly PrototypeModeSpec[] = [SIMPLE_MODE, FULL_MODE]

/**
 * The rule that makes an unattended run possible.
 *
 * Every round carries it, because a round that stops to ask a question does not
 * stall itself — it stalls the whole loop, which is waiting on a completion
 * marker that will never come.
 */
const UNATTENDED_RULE =
  '全程无人值守：不要停下来问我任何问题、不要等我确认、不要给选项让我挑。信息不足时自己选一个主流稳妥的方案直接做完，把做了什么假设写在总结里，我事后看总结。'

type ProjectOrientationMode = 'planning' | 'working' | 'testing' | 'deployment'

/**
 * Add the repository-orientation step that precedes every project round.
 * @param lines - the message under construction (mutated).
 * @param mode - the phase-specific authority after the inspection completes.
 */
function pushProjectOrientation(lines: string[], mode: ProjectOrientationMode): void {
  const authority = mode === 'planning'
    ? '本轮只做只读梳理和需求规划：可以读取文件并运行不改变项目状态的检查命令，但不要修改、创建或删除项目文件。'
    : mode === 'testing'
      ? '梳理后可以启动项目并运行测试，但这一轮只报告问题，不修改项目源文件。'
      : mode === 'deployment'
        ? '先完成本地项目梳理，再检查部署目标；确认构建方式、运行依赖和现有部署配置后才执行部署。'
        : '完成梳理并明确增量范围后才修改文件；不要在尚未理解现有实现时开始重写。'
  lines.push('', '【项目梳理】（先完成，再开始本轮任务）')
  lines.push('1. 先查找并读取适用于当前工作区的 AGENTS.md、README、项目说明、package/build 清单，再查看目录结构。')
  lines.push('2. 定向读取与本轮需求有关的源码、配置和测试，并检查 git status；现有未提交改动属于用户，必须保留，不得覆盖、回滚或改写。')
  lines.push('3. 开始本轮操作前先形成《项目现状梳理》，写明技术栈、启动与构建入口、相关模块、已经实现的能力、约束和本轮缺口；最终回复先给出这份梳理，再给出本轮结果。不要只做梳理就结束本轮。')
  lines.push('4. 现有实现与仓库约定优先于下面面向新项目的默认选型。已有能力只补缺口并沿用现有结构；只有确认工作区没有可用实现时才从零搭建。')
  lines.push('5. 如果本会话前文已有项目梳理，先核对工作区是否变化；未变化时简短确认并继续，不要重复猜测或重新搭建。')
  lines.push(authority)
}

/**
 * Built-in rules carried by every hand-off regardless of shape. The framework
 * line is phrased as a default rather than resolved here on purpose: 基础信息
 * keys are free-form, so any keyword sniffing would misfire — let the reading
 * agent apply the precedence.
 */
export const COMMON_RULES: readonly string[] = [
  '数据全部使用 mock：不连真实后端、不接数据库、不调用任何需要注册或密钥的第三方服务。mock 数据直接写在前端，字段结构贴近真实业务，每个列表至少准备 5 条可读的中文样例数据。',
  '前端框架：以上「基础信息」里已指定的以其为准；未指定则一律使用 Vue 3。其余技术选型同理，基础信息优先。',
  '增删改查要在前端内存里真实生效 —— 新增、编辑、删除后列表与详情立即更新；刷新页面回到初始 mock 属于预期行为。',
  '上面列出的每一个功能点都要有可见、可点击的界面入口；本轮确实不实现的，必须给出占位页面和说明文案，不允许留死链接或空白页。',
  '界面文案统一用中文；布局桌面优先，窄屏不塌陷即可。',
  '交付时说明启动方式，并确认代码可以直接运行。',
]

/**
 * Built-in rules for 正式开发. They deliberately overlap 原型 on nothing: the
 * hand-off continues in the prototype's own session, which already carries the
 * 原型 rules — these are the delta that turns that prototype into a project.
 */
export const DEVELOP_RULES: readonly string[] = [
  '这一轮是正式开发，不是 demo：功能要真正跑通，代码组织、错误处理、加载态与空态、表单校验、权限拦截都按能上线的标准写，不允许出现「此处省略」「同上」「略」之类的占位。',
  '前端沿用原型阶段的技术选型；如果需要后端，按「基础信息」里指定的框架搭一个可运行的工程；基础信息没写的，你自己选一个主流稳妥的方案直接做，并在总结里说明选了什么、为什么。',
  '原型的 mock 数据收敛成可替换的一层：接口调用集中在 api/service 层，将来切真实接口只改这一层，页面代码不动。',
  '所有外部资源与可配置项统一集中到项目根目录的 .env.example —— 数据库连接、第三方服务地址与密钥、端口、对象存储、短信/邮件服务等，一项都不要散落在代码里。',
  '.env.example 每一项都要写注释，说明这一项做什么用、从哪里获取、是否必填、示例值长什么样；真实密钥一律不写，用占位值。前后端各有一份时分别给出，并说明各自放在哪个目录。',
  '代码读配置一律走环境变量，不允许把地址、密钥、账号硬编码进源码。',
  '本轮结束后输出一份《本轮开发总结》，至少覆盖：本轮完成了哪些功能点（对应上面的功能点清单）、新增与修改了哪些文件、引入了哪些依赖、.env.example 新增了哪些配置项、已知问题与未完成项、下一轮建议。',
  '给出完整的启动步骤（安装依赖、配置 .env、启动前后端），并确认按这些步骤能跑起来。',
]

/**
 * Built-in rules for 测试. Report-only on purpose: this phase's job is to
 * surface problems and hand the list back, not to start editing — deciding
 * what gets fixed is the next round's 开发 hand-off.
 */
export const TEST_RULES: readonly string[] = [
  '先自测再报告：对着上面的功能点清单逐条走查，把项目实际跑起来点一遍，不允许只读代码就下结论。',
  '覆盖面至少包括：主流程、边界值、空数据、异常输入、必填与格式校验、权限拦截、接口失败与超时、刷新与后退、浏览器控制台报错。',
  '每个问题按统一格式列出：编号、标题、严重级别（P0 阻塞 / P1 严重 / P2 一般）、复现步骤、期望结果、实际结果、涉及文件。',
  '通过的功能点也要逐条列出来标注「通过」—— 我需要知道这一轮到底覆盖了哪些，而不只是坏的那些。',
  '最后给一份《本轮测试报告》：通过数与失败数、按严重级别的分布、最该优先修的三个、以及是否建议进入上线。',
  '这一轮只报告不修改代码 —— 修哪些由面板决定并单独派给你，这里只要把问题列清楚。',
]

/**
 * Built-in rules for a 修复 round. Scope discipline is the point: the user
 * picked a subset precisely because they do not want everything touched.
 */
export const FIX_RULES: readonly string[] = [
  '只修下面列出的这几条，不要顺手改别的；确实必须连带改动的，单独说明为什么非改不可。',
  '每条都先复现、再定位根因、再动手改。复现不出来的要说清楚试过什么，不要猜着改。',
  '不要为了让问题消失而绕过校验、注释掉逻辑或吞掉异常 —— 修根因。',
  '涉及 .env.example 的新增或改名，同步更新并说明。',
  '改完逐条说明：问题标题、根因、改了哪些文件、怎么验证的。',
  '结束时给出《本轮修复总结》：修好了哪几条、没修成的哪几条及原因、有没有引入回归风险。',
]

/** A tiny id generator sufficient for a local, non-replicated list. */
let seq = 0

/**
 * Mint a process-local identifier for a panel record.
 * @param prefix - record-kind prefix.
 * @returns A timestamped identifier unique within this browser process.
 */
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

/**
 * Turn a parsed expansion into board modules, minting fresh ids.
 * @param modules - the parsed modules.
 * @returns board-shaped module groups.
 */
export function toModuleGroups(modules: readonly ParsedRequirement['modules'][number][]): ModuleGroup[] {
  return modules.map(mod => ({
    id: nextId('mod'),
    name: mod.name,
    points: mod.points.map(point => ({ ...point })),
  }))
}

/**
 * Turn a parsed report entry into a board bug.
 * @param bug - the parsed problem.
 * @returns a board-shaped bug, open by default.
 */
export function toBugItem(bug: ParsedBug): BugItem {
  return {
    id: nextId('bug'),
    title: bug.title,
    detail: bug.detail,
    severity: bug.severity,
    status: 'open',
    createdAt: Date.now(),
  }
}

/**
 * The 基础信息 / 需求 / 功能点 sections shared by every hand-off.
 * @param info - 基础信息 key/value fields.
 * @param requirements - the manually added requirements.
 * @param groups - confirmed feature points, grouped by source requirement.
 * @returns the section lines, in menu order.
 */
export function baseSections(
  info: readonly InfoEntry[],
  requirements: readonly Requirement[],
  groups: readonly RequirementGroup[],
): string[] {
  const lines: string[] = ['【基础信息】']
  lines.push(...(info.length === 0 ? ['（无）'] : info.map(entry => `${entry.key}: ${entry.value}`)))
  lines.push('', '【需求】')
  if (requirements.length === 0) lines.push('（无）')
  for (const req of requirements) {
    // A requirement nobody expanded has no feature points below, so its own
    // text IS the specification for it — flagged so the round does not skip it
    // just because it is missing from the 功能点 section.
    const bare = req.modules.length === 0 ? '（未拆功能点，请直接按这条需求本身的描述实现）' : ''
    lines.push(`- ${req.text}${bare}`)
  }
  lines.push('', '【功能点】')
  lines.push(...(groups.length === 0
    ? ['（无）']
    : groups.flatMap(group => [
      `需求「${group.reqText}」：`,
      ...group.modules.flatMap(mod => [
        `  模块 ${mod.name}：`,
        ...mod.points.map((point) => {
          const state = point.done === true
            ? `（已完成${point.doneVersion === undefined ? '' : ` · 原型 v${point.doneVersion}`}）`
            : '（未完成）'
          return `    - [${point.priority}] ${point.name}${state}：${point.description}`
        }),
      ]),
    ])))
  return lines
}

/**
 * Append the user's free-form text as the trailing 补充说明 section. Last on
 * purpose: it is their own late word, so it outranks the generated sections it
 * follows.
 * @param lines - the message under construction (mutated).
 * @param extra - free-form text; blank appends nothing.
 */
export function pushExtra(lines: string[], extra: string): void {
  if (extra.trim() === '') return
  lines.push('', '【补充说明】（本次追加，与上文冲突时以此为准）')
  lines.push(extra.trim())
}

/**
 * Assemble the requirement-expansion prompt.
 *
 * Asks for every requirement in one turn rather than one turn each: the model
 * seeing them together is what lets it place a shared module once instead of
 * duplicating it per requirement.
 *
 * Carries what the project already has. A requirement added to a live project
 * is an increment: its points must land in the existing module structure and
 * must not re-propose what is already confirmed — and a fresh session would know
 * none of that unless told.
 * @param info - 基础信息 key/value fields, which constrain the answer.
 * @param requirements - the requirements to expand, in board order.
 * @param existing - feature points already confirmed, grouped by requirement.
 * @returns the prompt text.
 */
export function buildExpandPrompt(
  info: readonly InfoEntry[],
  requirements: readonly Requirement[],
  existing: readonly RequirementGroup[] = [],
): string {
  const lines: string[] = ['【这条会话是做什么的】']
  lines.push('这是本项目的「需求规划」会话。先只读梳理当前仓库，再把需求拆成基于项目现状的增量功能点；不要写代码或修改文件。')
  pushProjectOrientation(lines, 'planning')
  lines.push('', '【基础信息】')
  lines.push(...(info.length === 0 ? ['（无）'] : info.map(entry => `${entry.key}: ${entry.value}`)))
  if (existing.length > 0) {
    lines.push('', '【已有功能点】（之前的需求已经确认过的；这是项目现状，不是要你重做的东西）')
    for (const group of existing) {
      lines.push(`需求「${group.reqText}」：`)
      for (const mod of group.modules) {
        lines.push(`  模块 ${mod.name}：${mod.points.map(point => point.name).join('、')}`)
      }
    }
  }
  lines.push('', existing.length > 0 ? '【本次新增的需求】' : '【需求列表】')
  requirements.forEach((req, position) => { lines.push(`${position + 1}. ${req.text}`) })
  lines.push('', existing.length > 0
    ? '请把本次新增的每一条需求展开成具体的功能点，按模块分组，并放进上面已有的项目结构里。'
    : '请把上面每一条需求展开成具体的功能点，按模块分组。')
  lines.push('', '要求：')
  lines.push('1. 逐条需求分别展开；模块按业务划分（例如 客户管理、商机管理），不要按技术分层（不要出现「前端」「数据库」这种模块）。')
  lines.push('2. 每个功能点给出：名称、优先级、一句话描述。P0 = 没有它系统跑不起来，P1 = 核心体验，P2 = 锦上添花。')
  lines.push('3. 粒度到能直接照着开发；每个模块 3 到 8 个功能点，避免又大又空的条目。')
  lines.push('4. 结合上面的基础信息判断，不要给出与既定技术选型矛盾的功能点。')
  lines.push('5. index 字段必须回填上面需求列表里的编号，用来对应回去。')
  if (existing.length > 0) {
    lines.push('6. 新功能点能归入已有模块的，模块名逐字沿用上面的名字（我按模块名合并，改一个字就会变成两个模块）；确实是新领域才新建模块。')
    lines.push('7. 上面【已有功能点】里出现过的一律不要再提，只输出这次需求带来的增量；和已有功能点冲突或重叠的，说明如何调整而不是重复列出。')
  }
  lines.push(...jsonContract(
    '{"requirements":[{"index":1,"modules":[{"name":"模块名","points":[{"name":"功能点名","priority":"P0","description":"一句话描述"}]}]}]}',
  ))
  return lines.join('\n')
}

/**
 * The completion protocol every round carries.
 *
 * A round routinely spans several turns — a build gets interrupted, the user
 * says 继续, and only a later turn finishes it. Nothing observable at the turn
 * boundary distinguishes "done" from "paused halfway", so the round declares it
 * instead, and every consumer waits for that declaration.
 * @param extraFields - additional keys the same object must carry (测试's bugs).
 * @returns the instruction lines.
 */
export function roundContract(extraFields = ''): string[] {
  return [
    '',
    '【本轮完成标记】（必须遵守）',
    '每次回复的最后都输出一个 json 代码块（三个反引号，语言标注 json），只包含这一个对象：',
    `{"roundComplete": true${extraFields}}   —— 本轮要求的事情全部做完了，总结也已给出`,
    `{"roundComplete": false${extraFields}}  —— 还没做完（被中断、上下文不够、或你打算分几次做），我会让你继续`,
    '没做完就不要写 true。我依赖这个标记判断这一轮是否结束：写错会让后续阶段基于半成品继续，也会让「本轮总结」缺失。',
  ]
}

/**
 * The re-ask for an expansion reply that carried no usable json.
 *
 * Same principle as the round probe: one short question with one allowed
 * answer shape, asked after the fact, beats trusting a format instruction
 * buried at the end of a long prompt.
 * @returns the probe text.
 */
export function expandProbePrompt(): string {
  return [
    '【格式确认】上面的功能点我没能解析出来。',
    '',
    '本次回复请只输出一个 json 代码块，不要有任何其他文字：',
    '{"requirements":[{"index":1,"modules":[{"name":"模块名","points":[{"name":"功能点名","priority":"P0","description":"一句话描述"}]}]}]}',
    '',
    'index 就是刚才需求列表里的编号。内容用你上一条回复里已经想好的功能点，不用重新构思。',
  ].join('\n')
}

/**
 * The question asked when a turn ended without the completion marker.
 *
 * The contract at the end of a long build prompt is routinely forgotten — the
 * round finishes, writes its summary, and never emits the json. Rather than
 * trust that recall, ask afterwards: one short question with one allowed answer
 * shape is something a model answers reliably, and it doubles as the harvest
 * for rounds whose structured result never arrived either.
 * @param kind - the round's kind, which decides the extra fields asked for.
 * @param noun - the round's phase noun, for the prose.
 * @returns the probe text.
 */
export function probePrompt(kind: HandOffRecord['kind'], noun: string): string {
  const shape = kind === 'test'
    ? '{"roundComplete": true, "bugs": [{"title":"问题标题","severity":"P0","detail":"复现步骤 / 期望 / 实际"}]}'
    : kind === 'fix'
      ? '{"roundComplete": true, "fixed": ["问题标题1"], "unfixed": [{"title":"问题标题2","reason":"原因"}]}'
      : kind === 'develop'
        ? '{"roundComplete": true, "completedPoints": ["功能点名1", "功能点名2"]}'
        : '{"roundComplete": true}'
  const extra = kind === 'test'
    ? ['bugs 里放这一轮测出来的所有问题，一个都没有就给空数组 []。']
    : kind === 'fix'
      ? ['fixed 放确实改好并验证过的问题标题，unfixed 放没修成的和原因，标题逐字照抄，没有就给空数组 []。']
      : kind === 'develop'
        ? ['completedPoints 放这一轮真正实现完并验证过的功能点名，逐字照抄功能点清单里的名字，没有就给空数组 []。']
        : []
  return [
    `【状态确认】刚才那一轮${noun}到此为止，我需要一个机器可读的结论。`,
    '',
    '本次回复请只输出一个 json 代码块，不要有任何其他文字、不要继续干活：',
    shape,
    '',
    'roundComplete：这一轮要求的事情全部做完了写 true；还没做完（被中断、还差一部分）写 false，我会让你继续。',
    ...extra,
  ].join('\n')
}

/**
 * The re-ask for a round that declared itself finished but sent no structured
 * result.
 *
 * A separate question from {@link probePrompt} because the completion marker is
 * already known: asking for it again invites a round that IS done to answer the
 * easy half and drop the half that matters. This asks only for the data, and
 * says outright that the round is over so it does not start working again.
 * @param kind - the round's kind, which decides the fields asked for.
 * @param noun - the round's phase noun, for the prose.
 * @returns the probe text, or undefined for a kind that harvests nothing.
 */
export function harvestProbePrompt(
  kind: HandOffRecord['kind'],
  noun: string,
): string | undefined {
  const ask = kind === 'test'
    ? {
      shape: '{"bugs":[{"title":"问题标题","severity":"P0","detail":"复现步骤 / 期望 / 实际"}]}',
      note: 'bugs 里放这一轮测出来的所有问题，一个都没有就给空数组 []。',
    }
    : kind === 'fix'
      ? {
        shape: '{"fixed":["问题标题1"],"unfixed":[{"title":"问题标题2","reason":"原因"}]}',
        note: 'fixed 放确实改好并验证过的问题标题，unfixed 放没修成的和原因。标题逐字照抄我给你的那份清单，我按标题回填状态。两个数组都要出现，没有就给空数组 []。',
      }
      : kind === 'develop'
        ? {
          shape: '{"completedPoints":["功能点名1","功能点名2"]}',
          note: 'completedPoints 放这一轮真正实现完并自测通过的功能点名，逐字照抄功能点清单里的名字，没有就给空数组 []。',
        }
        : undefined
  if (ask === undefined) return undefined
  return [
    `【结果确认】这一轮${noun}你已经说完成了，但我没拿到机器可读的结果，面板没法更新。`,
    '',
    '本次回复请只输出一个 json 代码块，不要有任何其他文字、不要继续干活、不要重做：',
    ask.shape,
    '',
    ask.note,
  ].join('\n')
}

/**
 * The message that resumes an unfinished round.
 * @param noun - the round's phase noun (开发 / 测试 / 修复 / 上线 / 原型).
 * @returns the continuation text.
 */
export function continuePrompt(noun: string): string {
  return [
    `【继续本轮${noun}】`,
    '接着上面没做完的部分继续，不要重头再来，也不要改动已经做好的部分。',
    `全部做完后再给出《本轮${noun}总结》，并按约定输出完成标记。`,
    '如果这一轮还是做不完，就照实输出 {"roundComplete": false}，我会再让你继续。',
  ].join('\n')
}

/** Leading list ordinal, as the prompt numbers its problem list (`1. `). */
const ORDINAL_PREFIX = /^\s*\d+\s*[.、)）:：-]\s*/u

/** Leading severity tag, in the bracket styles a model reaches for. */
const SEVERITY_PREFIX =
  /^\s*(?:[\[(（【]\s*p[012]\s*[\])）】]|p[012](?=\s|[:：、.-]))\s*[:：、.-]?\s*/iu

/**
 * Compare two problem titles the way a round's report has to be matched.
 *
 * The round is asked to echo titles verbatim, but whitespace and full/half
 * width punctuation drift anyway; a title that fails to match would strand its
 * problem in 修复中 forever, which is exactly the dead end this feedback path
 * exists to remove.
 * @param value - a title from either side.
 * @returns the comparison key.
 */
function titleKey(value: string): string {
  // Strip what the prompt's own layout puts in front of a title: a list
  // ordinal and a severity tag. A round told to copy a title verbatim copies
  // the whole line it sees, tag included.
  return value
    .replace(ORDINAL_PREFIX, '')
    .replace(SEVERITY_PREFIX, '')
    // \s already covers U+3000 under the u flag.
    .replace(/\s/gu, '')
    .toLowerCase()
}

/**
 * Fold a test round's reported problems into the board.
 *
 * Matched by title, because that is the only stable identity a report carries.
 * A problem already unsettled on the board is not added again — a re-test is
 * expected to re-report what is still broken, and duplicating it would bury the
 * board. One already marked 已修复/不修复 that comes back is REOPENED rather
 * than skipped: the test just found it again, which is a regression, not noise.
 * @param existing - the board, newest first.
 * @param fresh - the problems this round reported.
 * @returns the next board plus what changed, for the row's note.
 */
export function mergeBugs(
  existing: readonly BugItem[],
  fresh: readonly ParsedBug[],
): { bugs: BugItem[]; added: number; reopened: number } {
  const bugs = existing.map(bug => ({ ...bug }))
  let added = 0
  let reopened = 0
  for (const parsed of fresh) {
    const title = parsed.title.trim()
    if (title === '') continue
    // titleKey, not equality: a report echoes the decorated line it was shown,
    // and an exact compare here would file the same problem twice.
    const prior = bugs.find(bug => titleKey(bug.title) === titleKey(title))
    if (prior === undefined) {
      bugs.unshift(toBugItem(parsed))
      added += 1
      continue
    }
    if (prior.status === 'fixed' || prior.status === 'wontfix') {
      prior.status = 'open'
      prior.severity = parsed.severity
      reopened += 1
    }
  }
  return { bugs, added, reopened }
}

/**
 * Fold a fix round's outcome back onto the board.
 *
 * Closes the loop: a dispatched problem sits in 修复中 until this says whether
 * the round actually closed it. Anything the round did not claim stays open —
 * silence is never read as success.
 * @param existing - the board, newest first.
 * @param outcome - what the round reported.
 * @returns the next board plus what changed, for the row's note.
 */
export function applyFixOutcome(
  existing: readonly BugItem[],
  outcome: ParsedFixOutcome,
): { bugs: BugItem[]; fixed: number; unfixed: number; unmatched: number } {
  const bugs = existing.map(bug => ({ ...bug }))
  const find = (title: string) => bugs.find(bug => titleKey(bug.title) === titleKey(title))
  let fixed = 0
  let unfixed = 0
  let unmatched = 0

  for (const title of outcome.fixed) {
    const bug = find(title)
    if (bug === undefined) {
      unmatched += 1
      continue
    }
    bug.status = 'fixed'
    bug.note = '本轮已修复'
    fixed += 1
  }
  for (const entry of outcome.unfixed) {
    const bug = find(entry.title)
    if (bug === undefined) {
      unmatched += 1
      continue
    }
    // Back to 待修复, not left in 修复中: the round is over and it is still
    // broken, so it must read as outstanding work rather than work in flight.
    bug.status = 'open'
    bug.note = entry.reason === '' ? '本轮未修复' : `本轮未修复：${entry.reason}`
    unfixed += 1
  }
  return { bugs, fixed, unfixed, unmatched }
}

/**
 * Mark the feature points a 开发 round reported as implemented.
 *
 * Matched by name the same tolerant way fix outcomes match titles. Stamped with
 * when and against which 原型 version, so the 功能点 board answers "what is
 * left" without anyone reading a transcript.
 * @param groups - confirmed feature points, grouped by requirement.
 * @param names - point names the round claims to have finished.
 * @param version - the 原型 version the round was built against.
 * @returns the next groups plus what matched, for the row's note.
 */
export function applyDevelopOutcome(
  groups: readonly RequirementGroup[],
  names: readonly string[],
  version: number | undefined,
): { groups: RequirementGroup[]; done: number; unmatched: number } {
  const wanted = new Map(names.map(name => [titleKey(name), name]))
  const matched = new Set<string>()
  let done = 0
  const next = groups.map(group => ({
    ...group,
    modules: group.modules.map(mod => ({
      ...mod,
      points: mod.points.map((point) => {
        const key = titleKey(point.name)
        if (!wanted.has(key)) return point
        matched.add(key)
        if (point.done === true) return point
        done += 1
        return {
          ...point,
          done: true,
          doneAt: Date.now(),
          ...(version === undefined ? {} : { doneVersion: version }),
        }
      }),
    })),
  }))
  return { groups: next, done, unmatched: wanted.size - matched.size }
}

/**
 * The session this project is already running in.
 *
 * Every phase continues there rather than opening its own: a round that starts
 * in a fresh session knows nothing of what was built before it, and the output
 * drifts from the previous version. Dropped rounds are skipped (their session
 * is the one the user disowned) and so is a session that no longer resolves.
 * @param records - dispatched rounds, newest first.
 * @param isLive - whether a session id still resolves.
 * @returns the session to continue in, or undefined when there is none.
 */
export function projectSession(
  records: readonly HandOffRecord[],
  isLive: (sessionId: string) => boolean,
): string | undefined {
  return records.find(record => record.status !== 'dropped' && isLive(record.sessionId))?.sessionId
}

/**
 * A compact ledger of what this project has already dispatched.
 *
 * Only used when a round has to open a FRESH session — continuing in the
 * project session needs no ledger, because that transcript is the history. A
 * ledger rather than a replay: re-sending each round's full text would blow up
 * the message and mostly repeat the base sections that follow it anyway.
 * @param records - dispatched rounds, newest first.
 * @returns the section lines, or an empty array when nothing was dispatched.
 */
export function historyLedger(records: readonly HandOffRecord[]): string[] {
  if (records.length === 0) return []
  const status = new Map(HANDOFF_STATUSES.map(item => [item.id, item.label]))
  const lines = [
    '【此前进度】（之前的会话已不可用，这里是它做过什么的摘要，避免这一轮跑偏）',
  ]
  // Oldest first: the reader wants the project's chronology, not the panel's
  // newest-first display order.
  for (const record of [...records].reverse()) {
    const shape = record.mode === undefined
      ? ''
      : `（${record.mode === 'full' ? '完整项目' : '简易项目'}）`
    lines.push(`- ${protocolRecordLine(record)}${shape} —— ${status.get(record.status) ?? record.status}`)
  }
  return lines
}

/**
 * Assemble the 原型 hand-off message. Single source of truth: both the
 * on-screen preview and the message actually sent read this.
 * @param info - 基础信息 key/value fields.
 * @param requirements - the manually added requirements.
 * @param groups - confirmed feature points, grouped by source requirement.
 * @param mode - the chosen delivery shape, which selects its rule set.
 * @param extra - free-form text appended by the user before sending.
 * @param version - the version this generation carries (v1, v2, …).
 * @param continuing - true when this lands in the session earlier versions were
 *   built in, so the transcript above already is the history.
 * @param records - dispatched rounds, newest first (ledger source when opening fresh).
 * @returns the plain-text context the session receives.
 */
export function buildPrototypeContext(
  info: readonly InfoEntry[],
  requirements: readonly Requirement[],
  groups: readonly RequirementGroup[],
  mode: PrototypeMode,
  extra: string,
  version: number,
  continuing: boolean,
  records: readonly HandOffRecord[] = [],
): string {
  const lines = [`【原型 v${version}】本轮产出请标记为原型 v${version}；后续正式开发会按这个版本号来对应。`]
  if (version > 1) {
    lines.push(continuing
      ? `这是在上一版基础上的迭代：本会话里已经产出过更早的版本，请在它之上改出 v${version}，不要推倒重来，并说明相对上一版改了什么。`
      : `这是第 ${version} 版。之前版本是在另一条会话里做的，那条会话已不可用，所以下面重述完整上下文。`)
  }
  lines.push('')
  if (!continuing) lines.push(...historyLedger(records), '')
  lines.push(...baseSections(info, requirements, groups))
  pushProjectOrientation(lines, 'working')
  const spec = PROTOTYPE_MODES.find(item => item.id === mode) ?? SIMPLE_MODE
  lines.push('', '【开发约定】（内置要求，务必逐条遵守）')
  lines.push(`交付类型：${spec.label} —— ${spec.hint}`)
  let index = 1
  for (const rule of [UNATTENDED_RULE, ...spec.rules, ...COMMON_RULES]) lines.push(`${index++}. ${rule}`)
  pushExtra(lines, extra)
  lines.push('', `请基于以上基础信息、需求与功能点，在开发约定的前提下开始开发原型 v${version}。`)
  lines.push(...roundContract())
  return lines.join('\n')
}

/**
 * Assemble the 开发 hand-off message.
 *
 * Continuing in the prototype's own session means 基础信息 / 需求 / 功能点 are
 * already in that transcript, so they are restated only when the hand-off has
 * to open a fresh session instead.
 * @param info - 基础信息 key/value fields.
 * @param requirements - the manually added requirements.
 * @param groups - confirmed feature points, grouped by source requirement.
 * @param extra - free-form text appended by the user before sending.
 * @param withBase - restate the shared sections (a fresh session has no history).
 * @param baseVersion - the 原型 version this round builds on; undefined when
 *   there is no live prototype to match.
 * @param round - this round's number against that prototype version.
 * @param records - dispatched rounds, newest first (ledger source when opening fresh).
 * @returns the plain-text message the development session receives.
 */
export function buildDevelopContext(
  info: readonly InfoEntry[],
  requirements: readonly Requirement[],
  groups: readonly RequirementGroup[],
  extra: string,
  withBase: boolean,
  baseVersion: number | undefined,
  round: number,
  records: readonly HandOffRecord[] = [],
): string {
  const lines = withBase ? [...historyLedger(records), ...(records.length > 0 ? [''] : []), ...baseSections(info, requirements, groups)] : []
  if (withBase) lines.push('')
  const tag = baseVersion === undefined
    ? `【正式开发 · 第 ${round} 轮】`
    : `【正式开发 · 基于原型 v${baseVersion} · 第 ${round} 轮】`
  lines.push(tag)
  lines.push(baseVersion === undefined
    ? '这一轮直接进入正式开发阶段，把上面的需求与功能点做成一个完整的工程项目。'
    : `这一轮基于原型 v${baseVersion} 进入正式开发阶段，把它做成一个完整的工程项目；产出请标记为对应原型 v${baseVersion}。`)
  pushProjectOrientation(lines, 'working')
  lines.push('', '【开发约定】（内置要求，务必逐条遵守）')
  let index = 1
  for (const rule of [UNATTENDED_RULE, ...DEVELOP_RULES]) lines.push(`${index++}. ${rule}`)
  pushExtra(lines, extra)
  lines.push('', `请按以上开发约定开始本轮开发，并在结束时给出《本轮开发总结（第 ${round} 轮）》。`)
  // The readable 功能点 section decorates each name with its tier, its state
  // and its description; a round told to copy a name verbatim copies all of
  // that. So the copy source is a separate, bare list.
  const pending: string[] = []
  for (const group of groups) {
    for (const mod of group.modules) {
      for (const point of mod.points) {
        if (point.done !== true) pending.push(point.name)
      }
    }
  }
  if (pending.length > 0) {
    lines.push('', '【可报告的功能点名】（completedPoints 只能从这份清单里逐字挑，一个字都不要改）')
    for (const name of pending) lines.push(`- ${name}`)
  }
  lines.push(...jsonContract('{"roundComplete":true,"completedPoints":["功能点名1","功能点名2"]}'))
  lines.push('completedPoints 放这一轮真正实现完并自测通过的功能点，名字从上面【可报告的功能点名】里逐字复制 —— 不要带 [P0] 这类级别前缀、不要带（已完成）标记、不要带冒号后面的描述。')
  lines.push('只完成了一部分也照实列出已完成的那些，没有就给空数组 []。整轮只输出这一个 json 块。')
  return lines.join('\n')
}

/**
 * Human label for one record's headline: 原型 carries its own version, 开发
 * carries the 原型 version it matches plus its round.
 * @param record - the record to label.
 * @returns the headline text.
 */
export function protocolRecordLine(record: HandOffRecord): string {
  if (record.kind === 'prototype') return `原型 v${record.version}`
  const noun = record.kind === 'develop'
    ? '开发'
    : record.kind === 'test' ? '测试' : record.kind === 'fix' ? '修复' : '上线'
  return record.baseVersion === undefined
    ? `${noun} 第 ${record.version} 轮`
    : `${noun} 第 ${record.version} 轮 · 基于原型 v${record.baseVersion}`
}

/**
 * Assemble the 测试 hand-off message.
 *
 * Carries two inputs: the built-in self-test protocol, and whatever the user
 * filed by hand that is still worth acting on — a bug marked 已修复 or 不修复
 * has left the queue, so it is not re-sent.
 * @param info - 基础信息 key/value fields.
 * @param requirements - the manually added requirements.
 * @param groups - confirmed feature points, grouped by source requirement.
 * @param extra - free-form text appended by the user before sending.
 * @param withBase - restate the shared sections (a fresh session has no history).
 * @param baseVersion - the 原型 version under test, when one matches.
 * @param round - this round's number against that version.
 * @param bugs - the user's open problems, newest first.
 * @param records - dispatched rounds, newest first (ledger source when opening fresh).
 * @returns the plain-text message the test session receives.
 */
export function buildTestContext(
  info: readonly InfoEntry[],
  requirements: readonly Requirement[],
  groups: readonly RequirementGroup[],
  extra: string,
  withBase: boolean,
  baseVersion: number | undefined,
  round: number,
  bugs: readonly BugItem[],
  records: readonly HandOffRecord[] = [],
): string {
  const lines = withBase ? [...historyLedger(records), ...(records.length > 0 ? [''] : []), ...baseSections(info, requirements, groups)] : []
  if (withBase) lines.push('')
  lines.push(baseVersion === undefined
    ? `【测试 · 第 ${round} 轮】`
    : `【测试 · 基于原型 v${baseVersion} · 第 ${round} 轮】`)
  lines.push('对当前实现做一轮自动测试，把发现的问题列出来。')
  pushProjectOrientation(lines, 'testing')
  lines.push('', '【测试约定】（内置要求，务必逐条遵守）')
  let index = 1
  for (const rule of [UNATTENDED_RULE, ...TEST_RULES]) lines.push(`${index++}. ${rule}`)
  if (bugs.length > 0) {
    lines.push('', '【我手动提的问题】（请逐条复现并写进测试报告）')
    for (const bug of bugs) {
      lines.push(`- 严重级别 ${bug.severity} ｜ 标题：${bug.title}`)
      if (bug.detail.trim() !== '') lines.push(`  说明：${bug.detail.trim()}`)
    }
  }
  pushExtra(lines, extra)
  lines.push('', `请按以上测试约定开始本轮测试，并在结束时给出《本轮测试报告（第 ${round} 轮）》。`)
  lines.push(...jsonContract(
    '{"roundComplete":true,"bugs":[{"title":"问题标题","severity":"P0","detail":"复现步骤 / 期望结果 / 实际结果"}]}',
  ))
  lines.push('没有发现问题时 bugs 给空数组 []。这个 json 块是给程序读的，报告正文照常写。')
  lines.push(...roundContract(',"bugs":[…]'))
  lines.push('注意：整轮只输出这一个 json 块，roundComplete 和 bugs 放在同一个对象里，不要分成两块。')
  return lines.join('\n')
}

/**
 * Assemble the 上线 hand-off message.
 *
 * The SSH password is the one field with two renderings: the message actually
 * sent carries it (that is what makes the deploy work), while the archived copy
 * masks it. Callers pass `maskSecret` accordingly.
 * @param extra - free-form text appended by the user before sending.
 * @param target - the chosen release target, which selects its rule set.
 * @param server - SSH connection fields (server target only).
 * @param password - the SSH password (server target only).
 * @param round - this round's number.
 * @param baseVersion - the 原型 version being released, when one matches.
 * @param maskSecret - render the password as asterisks (archival copy).
 * @returns the plain-text message the release session receives.
 */
export function buildReleaseContext(
  extra: string,
  target: ReleaseTarget,
  server: ServerConfig,
  password: string,
  round: number,
  baseVersion: number | undefined,
  maskSecret: boolean,
): string {
  const spec = RELEASE_TARGETS.find(item => item.id === target) ?? CLOUDFLARE_TARGET
  const lines: string[] = []
  lines.push(baseVersion === undefined
    ? `【上线 · 第 ${round} 轮】`
    : `【上线 · 基于原型 v${baseVersion} · 第 ${round} 轮】`)
  lines.push(`部署方式：${spec.label} —— ${spec.hint}`)
  if (target === 'server') {
    const shown = (value: string, fallback: string) => value.trim() === '' ? fallback : value.trim()
    lines.push('', '【服务器连接信息】')
    lines.push(`地址: ${shown(server.host, '（未填，请先问我）')}`)
    lines.push(`SSH 端口: ${shown(server.port, '22')}`)
    lines.push(`用户名: ${shown(server.user, '（未填，请先问我）')}`)
    lines.push(`密码: ${password === '' ? '（未填，请先问我）' : maskSecret ? '********' : password}`)
    lines.push(`部署目录: ${shown(server.path, '（未填，请先问我）')}`)
  }
  pushProjectOrientation(lines, 'deployment')
  lines.push('', '【上线约定】（内置要求，务必逐条遵守）')
  let index = 1
  for (const rule of [UNATTENDED_RULE, ...spec.rules]) lines.push(`${index++}. ${rule}`)
  pushExtra(lines, extra)
  lines.push('', `请按以上上线约定开始本轮部署，并在结束时给出《本轮上线报告（第 ${round} 轮）》。`)
  lines.push(...roundContract())
  return lines.join('\n')
}

/**
 * Assemble the 修复 hand-off message: only the problems the user ticked.
 * @param bugs - the selected problems, in board order.
 * @param round - this round's number.
 * @param baseVersion - the 原型 version being fixed, when one matches.
 * @returns the plain-text message the development session receives.
 */
export function buildFixContext(
  bugs: readonly BugItem[],
  round: number,
  baseVersion: number | undefined,
): string {
  const lines: string[] = []
  lines.push(baseVersion === undefined
    ? `【修复 · 第 ${round} 轮】`
    : `【修复 · 基于原型 v${baseVersion} · 第 ${round} 轮】`)
  lines.push(`这一轮只修下面勾选的 ${bugs.length} 条问题，其余问题本轮不动。`)
  lines.push('', '【本轮要修的问题】')
  for (const [index, bug] of bugs.entries()) {
    // The title is labelled and put last on its own line: printing it as
    // `1. [P1] 样式问题` invited a round told to copy it verbatim to copy the
    // ordinal and the tag too, and then nothing matched.
    lines.push(`${index + 1}) 严重级别 ${bug.severity}`)
    lines.push(`   标题：${bug.title}`)
    if (bug.detail.trim() !== '') lines.push(`   说明：${bug.detail.trim()}`)
  }
  pushProjectOrientation(lines, 'working')
  lines.push('', '【修复约定】（内置要求，务必逐条遵守）')
  let index = 1
  for (const rule of [UNATTENDED_RULE, ...FIX_RULES]) lines.push(`${index++}. ${rule}`)
  lines.push('', `请按以上修复约定开始本轮修复，并在结束时给出《本轮修复总结（第 ${round} 轮）》。`)
  lines.push(...jsonContract(
    '{"roundComplete":true,"fixed":["问题标题1"],"unfixed":[{"title":"问题标题2","reason":"没修成的原因"}]}',
  ))
  lines.push('fixed 里放这一轮确实改好并验证过的问题，逐字照抄上面「标题：」后面那一段，不要带序号、不要带 [P1] 这类级别前缀、不要改写或简写 —— 我按标题回填状态。')
  lines.push('没修成的放进 unfixed 并写明原因。两个数组都必须出现，没有就给空数组 []。')
  lines.push('整轮只输出这一个 json 块，roundComplete / fixed / unfixed 放在同一个对象里。')
  return lines.join('\n')
}
