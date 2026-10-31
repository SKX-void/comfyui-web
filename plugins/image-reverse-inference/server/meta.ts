/**
 * 本插件的身份与跨模块共用的小常量。
 *
 * 单独一个文件是为了**不把 `ID`/`PACKAGE` 复制到每个模块里** —— 空间按包名分配，
 * 写错一处就会读到别的插件的目录。
 */
export const ID = 'image-reverse-inference';

/** 空间按包名分配，所以这里必须写本插件的包名 */
export const PACKAGE = '@comfyui-web/image-reverse-inference';

/** 上传到 ComfyUI `input/` 下的子目录：按插件分堆（ComfyUI 没有删除接口，只能靠分组） */
export const UPLOAD_SUBFOLDER = 'image-reverse-inference';

/**
 * 宿主 fastify 的 `bodyLimit`（`apps/server/src/index.ts`）。
 *
 * 实测：4,194,304 B 的请求体通过，多 1 字节就 413 `FST_ERR_CTP_BODY_TOO_LARGE`。
 * 前面若还挂着一层代理，真实上限可能更小（nginx 没配 `client_max_body_size` 时是 1m）——
 * 那种 413 发生在进 handler 之前，插件的兜底只能按宿主这个值算。
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** data URL 前缀 + JSON 外壳的余量（与 `client/src/compress.ts` 同一口径） */
const JSON_HEADROOM = 512;

/**
 * 单张图片的字节上限（服务端兜底）＝ 这个请求体最多能装多大的图。
 *
 * base64 会膨胀 4/3：`(4 MiB - 余量) × 3/4 ≈ 3.00 MB` 的图刚好 4 MiB 的 body。
 * 前端已经按同一公式压过，走到这里还超就说明请求不是本插件的前端发的。
 */
export const MAX_IMAGE_BYTES = Math.floor(((MAX_BODY_BYTES - JSON_HEADROOM) * 3) / 4);

/** 反推作业的等待上限：ComfyUI 排队 + 首次加载模型都可能慢 */
export const INFER_TIMEOUT_MS = 300_000;
