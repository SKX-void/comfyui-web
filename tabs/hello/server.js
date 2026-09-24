/**
 * Hello 工作流 —— 目录型 tab 插件的最小示例（PoC）。
 *
 * 它想证明四件事：
 *   1. **一个目录就是一个插件**：`tabs/hello/` 里只有三个文件，没有依赖、没有 node_modules、
 *      没有安装步骤（产物自包含，这是"丢进去就能用"的前提）；
 *   2. **宿主句柄照旧**：`ctx.routes` 挂自己的接口，`ctx.space` 拿一块 data/ 下的私有目录；
 *   3. **状态自持**：计数写在空间里的 `state.json` —— 宿主不碰、不解析、也不清理；
 *   4. **改代码热重挂**：存盘后宿主卸载重挂本插件（入口带 `?v=` 换 URL 绕开 ESM 缓存），
 *      `ctx.effect` 里的收尾会跑（`lifecycle.log` 多一对 unload/load），
 *      而 `state.json` 的计数继续累加 —— **内存状态归零，落盘状态留下**。
 *
 * 刻意不 import cordis：宿主已经把 cordis 打进自己的产物，插件再引一份就是两个实例。
 */
import fs from 'node:fs';

export const name = 'tab-hello';

// 核给的句柄：路由门面 + 文件空间
export const inject = ['routes', 'space'];

/** 目录名即 id：它同时是路由前缀（/api/p/hello）与前端资源前缀（/plugins/hello） */
const ID = 'hello';

/** 空间按**包名**分配（不是目录名、也不是 profile 里的行 id），所以要写 package.json 的 name */
const PACKAGE = '@comfyui-web/tab-hello';

export function apply(ctx) {
  const routes = ctx.routes.for(ID);
  const space = ctx.space.for(PACKAGE);
  const stateFile = space.resolve('state.json');
  /** 本次装载的进程内计数：它**会**随热重挂归零 —— 正好用来演示"内存状态 vs 落盘状态" */
  let servedInThisLoad = 0;

  /** 自己的格式自己定：宿主不认识这个文件，也就不会替你迁移或清理 */
  const readState = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { visits: Number(raw.visits) || 0, loads: Number(raw.loads) || 0 };
    } catch {
      return { visits: 0, loads: 0 };
    }
  };

  // 改代码 → 宿主会卸载重挂本插件（说明符带 ?v=）。收尾必须挂在这里，
  // 否则每次重挂都多留一份定时器 / 文件句柄 / 半截任务。
  // 把装载 / 卸载留痕写进自己的空间，好让"收尾真的跑了"看得见（`lifecycle.log`）。
  const lifecycle = space.resolve('lifecycle.log');
  const trace = (event) => {
    try {
      fs.appendFileSync(lifecycle, `${new Date().toISOString()} ${event}\n`);
    } catch {
      // 空间写不进去也不该让插件挂掉
    }
  };

  ctx.effect(() => {
    trace('load');
    return () => trace('unload');
  });

  routes.get('/api/hello', async () => {
    const state = readState();
    state.visits += 1;
    state.loads += 1;
    servedInThisLoad += 1;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    return {
      message: '来自 /tabs 目录型插件',
      visits: state.visits,
      /** 落盘状态：跨热重挂、跨重启都在 */
      loads: state.loads,
      /** 内存状态：热重挂 / 重启都会归零（需要活下来就写进 space） */
      servedInThisLoad,
      pluginDir: new URL('.', import.meta.url).pathname,
      space: space.root,
      pid: process.pid,
    };
  });
}

