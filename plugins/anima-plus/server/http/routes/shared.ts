import type { JobManager } from '../../jobs/manager.js';
import type { WorkflowDefinition } from '../../templates/loader.js';
import type { ComfyClient } from '../../comfy/types.js';
import type { WeilinClient } from '../../weilin/client.js';
import type { PresetStore } from '../../store/presets.js';
import type { LastStateStore } from '../../state.js';
import type { TriggerStore } from '../../triggers/store.js';
import type { TriggerResolver } from '../../triggers/resolve.js';
import type { ThumbnailCache } from '../../weilin/thumb.js';
import type { ServerConfig } from '../../config.js';
import type { DepsService } from '../../deps.js';

export interface RouteDeps {
  config: ServerConfig;
  deps: DepsService;
  workflow: WorkflowDefinition;
  jobs: JobManager;
  client: ComfyClient;
  weilin: WeilinClient;
  thumbs: ThumbnailCache;
  presets: PresetStore;
  /** 上次提交的出图参数快照（`<space>/last-state.json`） */
  state: LastStateStore;
  /** LoRA 触发词覆盖表 + 解析器（两者同源，一起注入免得路由各自 new） */
  triggers: { store: TriggerStore; resolver: TriggerResolver };
}

export const SSE_HEARTBEAT_MS = 15_000;
