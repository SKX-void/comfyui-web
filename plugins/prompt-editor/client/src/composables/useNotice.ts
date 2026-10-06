import { onUnmounted, ref } from 'vue';

/** 顶部一闪而过的提示：3.2s 后自己消失（同一时刻只有一条，新的顶掉旧的） */
export function useNotice() {
  const notice = ref('');
  let timer: number | null = null;

  function flash(message: string): void {
    notice.value = message;
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      notice.value = '';
    }, 3200);
  }

  // 卸载时不撤掉定时器，它还会往已经销毁的组件上写状态
  onUnmounted(() => {
    if (timer !== null) clearTimeout(timer);
  });

  return { notice, flash };
}
