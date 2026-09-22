import type { ApiErrorCode } from '@comfyui-web/shared';

/** 领域错误：路由层据此映射 HTTP 状态码 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('BAD_REQUEST', message, 400, details);
  }

  static templateNotFound(id: string): AppError {
    return new AppError('TEMPLATE_NOT_FOUND', `模板不存在: ${id}`, 404);
  }

  static templateValidation(message: string, details?: unknown): AppError {
    return new AppError('TEMPLATE_VALIDATION_FAILED', message, 422, details);
  }

  static graphValidation(message: string, details?: unknown): AppError {
    return new AppError('GRAPH_VALIDATION_FAILED', message, 422, details);
  }

  static jobNotFound(id: string): AppError {
    return new AppError('JOB_NOT_FOUND', `任务不存在: ${id}`, 404);
  }

  static comfyUnreachable(message: string): AppError {
    return new AppError('COMFYUI_UNREACHABLE', message, 503);
  }

  static comfyError(message: string, details?: unknown): AppError {
    return new AppError('COMFYUI_ERROR', message, 502, details);
  }

  /** 在途任务已达上限：直接劝退，比让任务静静躺在队列里诚实（v1-safety.md §8） */
  static queueFull(max: number): AppError {
    return new AppError(
      'QUEUE_FULL',
      `服务器繁忙：排队任务已达上限 ${max}，请等前面的任务跑完再提交`,
      429,
      { max },
    );
  }

  static payloadTooLarge(message: string): AppError {
    return new AppError('PAYLOAD_TOO_LARGE', message, 413);
  }
}
