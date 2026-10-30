export function keepDrawingPointer(container: HTMLElement) {
  const controller = new AbortController();
  const { signal } = controller;
  let active: { layer: HTMLElement; pointerId: number; pointerType: string } | null = null;

  const finish = (event: PointerEvent) => {
    if (active?.pointerId !== event.pointerId) return;
    const { layer, pointerId } = active;
    active = null;
    if (layer.hasPointerCapture(pointerId)) layer.releasePointerCapture(pointerId);
  };
  const cancel = () => {
    if (!active) return;
    const { layer, pointerId, pointerType } = active;
    layer.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId, pointerType }));
  };

  container.addEventListener("pointerdown", event => {
    const layer = event.target;
    if (active || !event.isPrimary || event.button !== 0 || !(layer instanceof HTMLElement)
      || !layer.matches(".annotationEditorLayer.inkEditing.drawing")) return;
    layer.setPointerCapture(event.pointerId);
    active = { layer, pointerId: event.pointerId, pointerType: event.pointerType };
  }, { signal });
  container.addEventListener("lostpointercapture", event => {
    if (active?.pointerId === event.pointerId) cancel();
  }, { signal });
  window.addEventListener("pointerup", finish, { signal });
  window.addEventListener("pointercancel", finish, { signal });
  window.addEventListener("blur", cancel, { signal });
  return () => { cancel(); controller.abort(); };
}
