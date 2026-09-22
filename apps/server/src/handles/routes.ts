import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => unknown;

/** 插件能不能对外服务：由宿主按 Loader 里该行的 fiber 状态（以及契约闸门）回答 */
export type ActivationResolver = (
  pluginId: string,
) => 'active' | 'disabled' | 'inactive' | 'unknown' | 'rejected';

/**
 * 后端路由挂载点（v2-architecture §5.3）。
 *
 * ## 为什么不用 fastify 自己的 register
 *
 * fastify 的路由表在 `ready()` 之后**冻结**：既不能撤销，也不能重复注册同一前缀。
 * 而本方案要求
 *   - 设置页保存配置 → 宿主**就地重载**该插件（同一个 id 要重新挂一次路由）；
 *   - 运行期停用插件 → 它的接口必须立刻不可达。
 * 所以这里自己维护一张可逆的路由表，只在启动时向 fastify 注册**一条**兜底路由
 * `/api/p/*`，运行期所有增删都是纯内存操作。
 *
 * ## 插件拿到的是什么
 *
 * 一个极小的路由门面：`get/post/put/patch/delete/all`，handler 签名与 fastify 一致
 * `(request, reply)`，路径支持 `:param` 段（捕获进 `request.params`）。
 * body 解析、JSON 序列化仍由 fastify 完成。
 */
export interface PluginRoutes {
  readonly pluginId: string;
  /** `/api/p/<pluginId>` */
  readonly prefix: string;
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  all(path: string, handler: RouteHandler): void;
}

const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]*$/;

interface CompiledRoute {
  segments: string[];
  handler: RouteHandler;
}

/** 一条 `*` 兜底路由的前缀 */
const MOUNT_PREFIX = '/api/p/';

function compile(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * 段匹配：段数必须一致（`*name` 除外）；`:name` 捕获一段，`*name` 捕获剩余全部。
 * `*name` 必须是最后一段 —— 透明反代要靠它接住任意深度的子路径。
 */
function matchRoute(route: CompiledRoute, parts: string[]): Record<string, string> | undefined {
  const segments = route.segments;
  const params: Record<string, string> = {};

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;

    if (segment.startsWith('*')) {
      params[segment.slice(1) || 'rest'] = parts
        .slice(index)
        .map((part) => decodeURIComponent(part))
        .join('/');
      return params;
    }

    const part = parts[index];
    if (part === undefined) return undefined;
    if (segment.startsWith(':')) {
      if (part === '') return undefined;
      params[segment.slice(1)] = decodeURIComponent(part);
      continue;
    }
    if (segment !== part) return undefined;
  }

  return segments.length === parts.length ? params : undefined;
}

class RouteTable implements PluginRoutes {
  readonly pluginId: string;
  readonly prefix: string;
  private readonly byMethod = new Map<string, CompiledRoute[]>();

  constructor(pluginId: string) {
    this.pluginId = pluginId;
    this.prefix = `${MOUNT_PREFIX}${pluginId}`;
  }

  private add(method: string, path: string, handler: RouteHandler): void {
    if (typeof handler !== 'function') {
      throw new Error(`[routes] ${this.pluginId} ${method} ${path}: handler 必须是函数`);
    }
    const list = this.byMethod.get(method) ?? [];
    list.push({ segments: compile(path), handler });
    this.byMethod.set(method, list);
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }
  put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler);
  }
  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }
  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }
  all(path: string, handler: RouteHandler): void {
    this.add('ALL', path, handler);
  }

  match(method: string, parts: string[]): { handler: RouteHandler; params: Record<string, string> } | undefined {
    for (const key of [method, 'ALL']) {
      for (const route of this.byMethod.get(key) ?? []) {
        const params = matchRoute(route, parts);
        if (params !== undefined) return { handler: route.handler, params };
      }
    }
    return undefined;
  }

  count(): number {
    let total = 0;
    for (const list of this.byMethod.values()) total += list.length;
    return total;
  }
}

export class RoutesService {
  private readonly app: FastifyInstance;
  private readonly tables = new Map<string, RouteTable>();
  private activation: ActivationResolver = () => 'active';

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  /** 宿主注入：按插件 id 查它在 Loader 里的运行状态 */
  setActivationResolver(resolver: ActivationResolver): void {
    this.activation = resolver;
  }

  /**
   * 领取本插件的路由表。
   *
   * **同一 id 再次调用会换一张新表** —— 这正是"配置改了就地重载"需要的语义：
   * 新的 apply 覆盖旧的注册，不会残留旧 handler 的闭包。
   */
  for(pluginId: string): PluginRoutes {
    if (!PLUGIN_ID_RE.test(pluginId)) {
      throw new Error(
        `[routes] 非法插件 id "${pluginId}"：只允许小写字母开头、[a-z0-9_-]（用于构造路由前缀）`,
      );
    }
    const table = new RouteTable(pluginId);
    this.tables.set(pluginId, table);
    return table;
  }

  /** 插件被卸载时清掉它的表（运行期停用则由 activation 判定兜住） */
  release(pluginId: string): void {
    this.tables.delete(pluginId);
  }

  list(): Array<{ pluginId: string; prefix: string; routes: number }> {
    return [...this.tables.entries()].map(([pluginId, table]) => ({
      pluginId,
      prefix: table.prefix,
      routes: table.count(),
    }));
  }

  /** 启动时向 fastify 注册唯一一条兜底路由 */
  install(): void {
    this.app.all(`${MOUNT_PREFIX}*`, async (request, reply) => {
      const rest = (request.params as Record<string, string | undefined>)['*'] ?? '';
      const slash = rest.indexOf('/');
      const pluginId = slash === -1 ? rest : rest.slice(0, slash);
      const tail = slash === -1 ? '' : rest.slice(slash + 1);

      if (pluginId === '') {
        return reply.code(404).send({ error: '缺少插件 id：路径形如 /api/p/<pluginId>/...' });
      }

      const state = this.activation(pluginId);
      if (state !== 'active') {
        const reason: Record<string, string> = {
          disabled: `插件 ${pluginId} 已被停用`,
          unknown: `没有名为 ${pluginId} 的插件`,
          rejected: `插件 ${pluginId} 未通过契约闸门，宿主拒绝加载它`,
          inactive: `插件 ${pluginId} 当前不可用（未激活）`,
        };
        return reply.code(503).send({ error: reason[state] ?? `插件 ${pluginId} 当前不可用` });
      }

      const table = this.tables.get(pluginId);
      if (table === undefined) {
        return reply.code(503).send({ error: `插件 ${pluginId} 没有挂载任何路由` });
      }

      const matched = table.match(request.method.toUpperCase(), compile(tail));
      if (matched === undefined) {
        return reply
          .code(404)
          .send({ error: `插件 ${pluginId} 没有路由 ${request.method.toUpperCase()} /${tail}` });
      }

      // 让插件 handler 拿到的 request.params 形如 { id: '7' }
      (request as { params: Record<string, string> }).params = matched.params;
      return matched.handler(request, reply);
    });
  }
}
