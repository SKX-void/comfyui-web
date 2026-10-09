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
 * 单张图片的字节上限（服务端兜底）。
 *
 * 前端压到 1MB 才发；这里留到 2MB 是因为宿主 fastify 的 `bodyLimit` 是 4MB，
 * 而 base64 会膨胀 4/3 —— 2MB 原图 ≈ 2.7MB JSON，仍在闸门内。
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 反推作业的等待上限：ComfyUI 排队 + 首次加载模型都可能慢 */
export const INFER_TIMEOUT_MS = 300_000;
