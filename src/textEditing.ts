import { AnnotationEditorType } from "pdfjs-dist";
import type { EventBus, PDFViewer } from "./viewer";

/** Finish a text box before pdf.js can interpret the same gesture as creating another. */
export function finishTextOnClickAway(container: HTMLElement, viewer: PDFViewer, eventBus: EventBus) {
  let editor: Element | null = null;
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof Element && container.contains(target)
      && target.matches('.freeTextEditor .internal[contenteditable="true"]')) {
      editor = target.closest(".freeTextEditor");
    }
  };
  const onModeChanged = ({ mode }: { mode: number }) => {
    if (mode !== AnnotationEditorType.FREETEXT) editor = null;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || event.ctrlKey
      || Number(viewer.annotationEditorMode) !== AnnotationEditorType.FREETEXT) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!editor?.isConnected || editor.contains(target) || target.closest('[aria-label="Annotation options"]')) return;

    // Changing mode commits nonempty text and removes empty editors through pdf.js.
    // Capture runs before its layer pointer handlers and the browser's focus change.
    // Do not leave a pointer-down pending in a layer whose pointer-up listener is being removed.
    if (container.contains(target)) event.stopPropagation();
    viewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
    editor = null;
  };
  container.addEventListener("focusin", onFocusIn);
  eventBus.on("annotationeditormodechanged", onModeChanged);
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    container.removeEventListener("focusin", onFocusIn);
    eventBus.off("annotationeditormodechanged", onModeChanged);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}
