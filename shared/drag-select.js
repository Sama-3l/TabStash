/**
 * Toggle checkboxes with a click-and-drag run.
 *
 * The first press decides the target state; every row passed over (and the gap
 * between) follows it. Rows are identified by `data-tab-id`; the caller owns the
 * selection state and paints the DOM through `apply`.
 *
 * @returns {boolean} true when a drag run started
 */
export function beginDragSelection(
  event,
  { root, rowSelector, handleSelector, getRows, isSelected, apply, onChange, onFinish },
) {
  if (event.button !== 0 || event.shiftKey || event.pointerType === 'touch') return false;
  const handle = event.target.closest(handleSelector || rowSelector);
  if (!handle || !root.contains(handle)) return false;
  const row = handle.closest(rowSelector);
  if (!row || !root.contains(row)) return false;

  const rows = getRows();
  const startIndex = rows.indexOf(row);
  if (startIndex < 0) return false;

  event.preventDefault();
  const value = !isSelected(row.dataset.tabId);
  let lastIndex = startIndex;
  let active = true;

  apply(row.dataset.tabId, value, row);
  onChange();

  const onMove = (moveEvent) => {
    if (!active || moveEvent.pointerId !== event.pointerId) return;
    const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
    const hovered = element?.closest(rowSelector);
    if (!hovered || !root.contains(hovered)) return;
    const currentRows = getRows();
    const index = currentRows.indexOf(hovered);
    if (index < 0 || index === lastIndex) return;

    const from = Math.min(lastIndex, index);
    const to = Math.max(lastIndex, index);
    for (let i = from; i <= to; i += 1) {
      const target = currentRows[i];
      if (target) apply(target.dataset.tabId, value, target);
    }
    lastIndex = index;
    onChange();
  };

  const finish = () => {
    if (!active) return;
    active = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    onFinish?.();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  return true;
}
