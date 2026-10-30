export type ContentSize = { height: number; width: number; requiredWidth: number; chromeHeight: number; explicit?: boolean };

/** Read untransformed DOM geometry; a table's scroll container hides its intrinsic width. */
export function measureContentSize(element: HTMLElement): ContentSize {
  const width = element.offsetWidth;
  let requiredWidth = Math.max(width, element.scrollWidth);
  for (const table of element.querySelectorAll<HTMLElement>('table')) {
    const wrapper = table.closest<HTMLElement>('.table-scroll,.control-grid') ?? table.parentElement;
    const inset = wrapper ? Math.max(0, width - wrapper.clientWidth) : 0;
    requiredWidth = Math.max(requiredWidth, Math.max(table.offsetWidth, table.scrollWidth) + inset);
  }
  const card = element.closest<HTMLElement>('[data-card-id]');
  const viewport = element.closest('[data-card-surface]')?.querySelector<HTMLElement>('.card-content-scroll');
  return { width, requiredWidth, height: Math.max(element.offsetHeight, element.scrollHeight), chromeHeight: Math.max(155, card && viewport ? card.offsetHeight - viewport.clientHeight : 0) };
}

export function contentSizeTarget(current: { width: number; height: number }, size: ContentSize) {
  return {
    width: Math.max(current.width, Math.min(1600, Math.ceil(current.width + Math.max(0, size.requiredWidth - size.width)))),
    height: Math.max(size.explicit ? current.height : 240, Math.min(100000, Math.ceil(size.height + size.chromeHeight))),
  };
}
