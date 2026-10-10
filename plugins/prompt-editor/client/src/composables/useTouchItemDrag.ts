import { onBeforeUnmount, ref } from 'vue';

/** 触屏拖拽的落点：和 model 的 ItemRef 同一套坐标（blockId + 插入位置） */
export interface TouchDropTarget {
  blockId: string;
  index: number;
}

interface TouchItemDragOptions {
  /** 起手：父级把 dragItem 设上（复用桌面拖拽的同一套状态，源条目自然进入拖拽态） */
  onStart: (blockId: string, index: number) => void;
  /** 手指悬停到某个落点（null = 没有有效落点） */
  onOver: (target: TouchDropTarget | null) => void;
  /** 松手：落在哪个点；null = 取消（父级负责清掉拖拽态） */
  onDrop: (target: TouchDropTarget | null) => void;
}

/**
 * 触屏条目拖拽：HTML5 drag 在触摸屏上不触发，这里用 Pointer Events 补一条路。
 * 起手由条目上的 ⠿ 把手发起，之后在 window 上跟 pointermove/up —— 拖拽是跨块的，
 * 手指会移出源卡片，监听必须挂在 window 上。
 *
 * 落点用 `elementFromPoint` 现找：条目格 / 块体 / 卡片分别带 data-block-id 与
 * data-item-index（或 data-tail-index），命中哪个就按桌面那套"插入位置"坐标给父级。
 */
export function useTouchItemDrag(options: TouchItemDragOptions) {
  const ghost = ref<{ x: number; y: number; text: string } | null>(null);

  let pointerId: number | null = null;
  let active = false;
  let text = '';

  function hitTest(x: number, y: number): TouchDropTarget | null {
    const el = document.elementFromPoint(x, y);
    if (el === null) return null;
    const cell = el.closest<HTMLElement>('.pe-chip-cell[data-block-id][data-item-index]');
    if (cell !== null) {
      const blockId = cell.dataset.blockId;
      const index = Number(cell.dataset.itemIndex);
      if (blockId !== undefined && Number.isInteger(index)) return { blockId, index };
    }
    const body = el.closest<HTMLElement>('.pe-block-body[data-block-id]');
    if (body !== null) {
      const blockId = body.dataset.blockId;
      const index = Number(body.dataset.tailIndex);
      if (blockId !== undefined && Number.isInteger(index)) return { blockId, index };
    }
    const card = el.closest<HTMLElement>('.pe-block[data-block-id]');
    if (card !== null) {
      const blockId = card.dataset.blockId;
      const index = Number(card.dataset.tailIndex);
      if (blockId !== undefined && Number.isInteger(index)) return { blockId, index };
    }
    return null;
  }

  function onMove(event: PointerEvent): void {
    if (!active || event.pointerId !== pointerId) return;
    event.preventDefault();
    ghost.value = { x: event.clientX, y: event.clientY, text };
    options.onOver(hitTest(event.clientX, event.clientY));
    // 手指推到屏幕上下边缘时滚一滚，不然跨块拖到折叠线以下的卡片够不着
    const edge = 72;
    if (event.clientY < edge) {
      window.scrollBy(0, -Math.max(4, (edge - event.clientY) / 6));
    } else if (event.clientY > window.innerHeight - edge) {
      window.scrollBy(0, Math.max(4, (event.clientY - (window.innerHeight - edge)) / 6));
    }
  }

  function stop(): void {
    if (!active) return;
    active = false;
    pointerId = null;
    text = '';
    ghost.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  }

  function onUp(event: PointerEvent): void {
    if (!active || event.pointerId !== pointerId) return;
    event.preventDefault();
    const target = hitTest(event.clientX, event.clientY);
    stop();
    options.onDrop(target);
  }

  function onCancel(event: PointerEvent): void {
    if (!active || event.pointerId !== pointerId) return;
    stop();
    options.onDrop(null);
  }

  function begin(event: PointerEvent, blockId: string, index: number, itemText: string): void {
    if (active) return;
    active = true;
    pointerId = event.pointerId;
    text = itemText;
    ghost.value = { x: event.clientX, y: event.clientY, text: itemText };
    options.onStart(blockId, index);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  onBeforeUnmount(stop);

  return { ghost, begin };
}
