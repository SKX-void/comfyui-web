/**
 * 深拷贝（仅用于 JSON 数据）。
 *
 * 刻意**不用 `structuredClone`**：它在部分移动端浏览器 / WebView 中不存在，
 * 一旦缺失就会在渲染路径上抛 `ReferenceError`，导致页面静默残缺
 * （表现为"数据加载了一半、表单整个不出现"）。
 *
 * 我们的值全部来自 JSON（模板默认值、表单值、API 响应），
 * JSON 往返语义足够，且在所有环境可用。
 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
