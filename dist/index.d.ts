/**
 * dsh-xunlei-bridge —— DSH 插件（宿主侧 / host 半）
 *
 * 作用：拦截 DSH 工具调用里出现的**下载链接**，自动交给迅雷新建下载任务。
 *
 * 为什么不用 `dsh/download:before`：
 *   DSH 0.1.5-rc.1 **没有**这个事件（全包扫描无 download 相关事件），
 *   真正可用的门控钩子是 `tools/pre-execute`（waterfall，签名见下）。
 *
 * 依赖说明：本文件**不 import 任何第三方包**（只用 node 内置）。
 *   插件以 link: / git: 方式装进 profile 时自身没有可解析的 node_modules，
 *   一旦 import 外部包，整个 profile 会启动失败（本机其它插件同样遵循此规则）。
 */
/** tools/pre-execute 收到的执行对象（只声明本插件用到的字段）。 */
interface ToolExecutionLike {
    name?: string;
    arguments?: unknown;
}
/** cordis 上下文的最小形状，避免为了类型而引入外部依赖。 */
interface CtxLike {
    logger?: {
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
    on(event: string, listener: (...args: any[]) => any, options?: {
        prepend?: boolean;
    }): unknown;
}
/** cordis 插件名：DSH 加载插件时必须读到它。 */
export declare const name = "dsh-xunlei-bridge";
/**
 * 本插件不依赖任何 cordis 服务，所以 inject 留空。
 * （本机其它插件写 inject: ['connection']，那是因为它们要用 connection 服务。）
 */
export declare const inject: string[];
/** 插件配置（在 profile 的 cordis.patch.yml 里以 config: 传入）。 */
export interface XunleiBridgeConfig {
    /** 迅雷可执行文件完整路径。 */
    thunderPath?: string;
    /** 识别模式：只认下载类命令，或抓取所有链接。 */
    mode?: 'download-commands' | 'all-urls';
    /** 是否禁止 DSH 自己下载（true=只走迅雷；false=两路都下，迅雷作备份）。 */
    blockOriginDownload?: boolean;
    /** 试运行：只写日志、不真的唤起迅雷。 */
    dryRun?: boolean;
    /** 同一个链接的去重时间窗口（秒），防止重复提交。 */
    dedupeSeconds?: number;
    /**
     * 审计日志文件路径。设置后每转发一个链接就往里追加一行，
     * 便于事后核对「到底交给迅雷了哪些链接」（也用于自动化验收断言）。
     */
    logFile?: string;
    /**
     * 不参与拦截的工具名。默认排除 `xunlei_download`——本机已装了
     * `@local/dsh-xunlei-download`，它注册了同名工具自己会提交迅雷，
     * 如果再被本插件抓一遍，同一个链接会出现两个迅雷任务。
     */
    ignoreTools?: string[];
}
/** 判断一个 URL 是否值得交给迅雷。 */
declare function looksDownloadable(url: string, mode: 'download-commands' | 'all-urls'): boolean;
/** 命令字符串看起来像是在下载吗。 */
declare function commandLooksDownload(command: string): boolean;
/** 从一次工具调用里抽出所有候选 URL。 */
declare function extractUrls(exec: ToolExecutionLike, mode: 'download-commands' | 'all-urls'): string[];
/** 插件主体。 */
export declare function apply(ctx: CtxLike, config?: XunleiBridgeConfig): void;
/** 供宿主自检/单测使用的内部工具（不属于 cordis 接口）。 */
export declare const __internal: {
    extractUrls: typeof extractUrls;
    looksDownloadable: typeof looksDownloadable;
    commandLooksDownload: typeof commandLooksDownload;
};
export {};
