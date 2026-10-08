import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_HOST_SETTINGS,
    loadHostSettings,
    writeHostSettings,
    type HostSettings,
} from './host-settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 是否运行在打包产物里（esbuild 注入，见 src/globals.d.ts） */
const BUNDLED = typeof __BUNDLED__ !== 'undefined' && __BUNDLED__;

const ROOT_MARKER = 'pnpm-workspace.yaml';

/**
 * 仓库根目录：源码态从 apps/server/src 往上找 pnpm-workspace.yaml；打包态**不往上看** ——
 * 产物是 dist/app/server.mjs，它的上级就是 dist/，而 dist/ 自成一体（app/ + tabs/ + data/）。
 * 否则在仓库里 `node dist/app/server.mjs` 会命中仓库根，和"整包搬走"跑出两套语义。
 */
export const repoRoot = (() => {
    const explicit = process.env.REPO_ROOT;
    if (explicit) return path.resolve(explicit);
    // 产物态：dist/ 就是根（REPO_ROOT 可显式覆盖，测试用）
    if (BUNDLED) return path.resolve(here, '..');

    for (let dir = here; ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, ROOT_MARKER))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
    }
    return path.resolve(here, '..', '..', '..');
})();

/**
 * 数据目录：**唯一一个不能写在 data/host.json 里的值**（它管着那个文件在哪儿）。
 * 内置默认 <repoRoot>/data，COMFYUI_WEB_DATA_DIR 可临时覆盖（换卷跑第二份实例）。
 *
 * 这也是"挂一个空 data 卷就能起来"的起点：目录不存在就建，配置文件不存在就写默认
 * （见 host-settings.ts 的 loadHostSettings）。
 */
export function resolveDataDir(): string {
    const env = process.env.COMFYUI_WEB_DATA_DIR;
    if (env !== undefined && env.trim() !== '') {
        return path.isAbsolute(env) ? env : path.join(repoRoot, env);
    }
    return path.join(repoRoot, 'data');
}

/** pino 内置级别（宿主不注册自定义级别，所以这里就是全集） */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** 日志格式全集 */
export const LOG_FORMATS = ['default', 'text', 'json'] as const;

/**
 * 控制台日志格式。`default` = 能 pretty 就 pretty（开发态且 pino-pretty 可解析），否则 JSON；
 * `text` = 宿主自带的文本格式（**不依赖 pino-pretty**，所以容器/产物态也能拿到人看的日志）；
 * `json` = 强制 JSON（喂采集器）。
 */
export type LogFormat = (typeof LOG_FORMATS)[number];

export interface HostConfig {
    /** 监听地址与端口（宿主唯一的端口，默认 8087） */
    host: string;
    port: number;
    logLevel: string;
    /** 控制台日志格式（`COMFYUI_WEB_LOG_FORMAT` 临时覆盖） */
    logFormat: LogFormat;
    /** 数据目录（绝对）：宿主配置、插件文件空间，都在这个卷里 */
    dataDir: string;
    /** 宿主配置文件：<dataDir>/host.json（不存在时由宿主写出默认值） */
    settingsFile: string;
    /** 插件空间根：<dataDir>/plugins/<包名>/ */
    pluginsDir: string;
    /**
     * 插件目录：每个子目录 = 一个**编译完的**工作流插件（目录名即 id，见 src/tabs.ts）。
     * 相对路径按仓库根解析。
     */
    tabsDir: string;
    /** 宿主前端产物目录（仅打包/生产态用于静态托管） */
    webDir: string;
}

export interface LoadedHostConfig {
    config: HostConfig;
    /** data 目录这次是新建的（首次启动 / 换了空卷） */
    dataDirCreated: boolean;
    /** data/host.json 这次是新建的（写进去的是默认值） */
    settingsCreated: boolean;
    /** 配置文件在、但读不出来；这次用默认值跑，**原文件没动** */
    settingsProblem?: string;
    /** 这次把老的 <dataDir>/ui-prefs.json 搬进了 host.json（旧文件保留在原地） */
    migratedLegacyPrefs?: string;
    /** 日志级别/格式取值不合法（已回落默认值）；由调用方在 logger 起来之后说出来 */
    logProblems?: string[];
}

/**
 * 读宿主配置。顺序上只有一个硬约束：**先定 dataDir，再读它里面的 host.json**
 * —— 所以 dataDir 走环境变量/内置默认，其余全在文件里（见 docs/config.md 第 1 节）。
 */
export function loadHostConfig(): LoadedHostConfig {
    const dataDir = resolveDataDir();
    const dataDirCreated = !fs.existsSync(dataDir);
    // 插件空间的家先备好：宿主不替插件写内容，但"这一格存在"是它的责任
    fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });

    const settingsFile = path.join(dataDir, 'host.json');
    const loaded = loadHostSettings(settingsFile);
    let settings: HostSettings = loaded.settings;

    // 一次性搬迁：老版本的 <dataDir>/ui-prefs.json（标签栏顺序 / 默认首页 / 统一地址）。
    // 只在**新建** host.json 时做；搬完不动旧文件（留给用户自己删，宿主不清理别人的文件）。
    const legacyPrefs = path.join(dataDir, 'ui-prefs.json');
    let migratedLegacy: string | undefined;
    if (loaded.created && fs.existsSync(legacyPrefs)) {
        try {
            settings = writeHostSettings(settingsFile, {
                ...settings,
                ...(JSON.parse(fs.readFileSync(legacyPrefs, 'utf8')) as object),
            });
            migratedLegacy = legacyPrefs;
        } catch {
            // 旧文件坏了就当没搬过：host.json 保持刚写进去的默认值
            settings = loaded.settings;
        }
    }

    const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
    const distApp = BUNDLED ? here : path.join(repoRoot, 'dist', 'app');

    // 环境变量只作**临时覆盖**（换端口起临时实例、跑测试），不是第二份配置来源：
    // 真源永远是 data/host.json；覆盖值也不写回文件。
    const envPortRaw = process.env.COMFYUI_WEB_PORT;
    const envPort =
        envPortRaw !== undefined && envPortRaw.trim() !== '' ? Number(envPortRaw) : undefined;
    const port =
        envPort !== undefined && Number.isInteger(envPort) && envPort > 0 && envPort <= 65535
            ? envPort
            : settings.port;

    // 日志是"人盯控制台"的事，所以级别与格式都允许环境变量临时覆盖（同样不写回 host.json）。
    // 非法值**不抛**：pino 遇到不认识的级别会直接 throw（"default level:verbose must be included
    // in custom levels"），一个拼错的级别不该让宿主起不来 —— 回落默认值，起来之后 warn 一次。
    const logProblems: string[] = [];
    const envLevel = (process.env.COMFYUI_WEB_LOG_LEVEL ?? '').trim();
    const rawLevel = envLevel !== '' ? envLevel : settings.logLevel;
    const logLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel)
        ? rawLevel
        : DEFAULT_HOST_SETTINGS.logLevel;
    if (logLevel !== rawLevel) {
        const from = envLevel !== '' ? 'COMFYUI_WEB_LOG_LEVEL' : 'host.json 的 logLevel';
        logProblems.push(`${from} = ${rawLevel} 不是合法级别（${LOG_LEVELS.join(' / ')}），本次用 ${logLevel}`);
    }

    const envFormat = (process.env.COMFYUI_WEB_LOG_FORMAT ?? '').trim().toLowerCase();
    if (envFormat !== '' && !(LOG_FORMATS as readonly string[]).includes(envFormat)) {
        logProblems.push(
            `COMFYUI_WEB_LOG_FORMAT = ${envFormat} 不是合法格式（${LOG_FORMATS.join(' / ')}），本次用 default`,
        );
    }
    const logFormat: LogFormat = (LOG_FORMATS as readonly string[]).includes(envFormat)
        ? (envFormat as LogFormat)
        : 'text';

    return {
        config: {
            host: settings.host,
            port,
            logLevel,
            logFormat,
            dataDir,
            settingsFile,
            pluginsDir: path.join(dataDir, 'plugins'),
            tabsDir: abs(settings.tabsDir),
            // 前端位置固定：产物态是 server.mjs 同级的 web/，源码态是 <仓库根>/dist/app/web
            webDir: path.join(distApp, 'web'),
        },
        dataDirCreated,
        settingsCreated: loaded.created,
        ...(loaded.problem !== undefined ? { settingsProblem: loaded.problem } : {}),
        ...(migratedLegacy !== undefined ? { migratedLegacyPrefs: migratedLegacy } : {}),
        ...(logProblems.length > 0 ? { logProblems } : {}),
    };
}
