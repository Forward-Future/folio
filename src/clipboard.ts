// Writing to the clipboard.
// The desktop shell denies the renderer's Clipboard API: its permission handlers only admit the
// camera, so `navigator.clipboard.writeText` and `.write` reject with NotAllowedError. The desktop
// build therefore writes through the main process. The browser build has no shell, so it uses the
// Clipboard API and is subject to the usual gesture and permission rules.
export async function copyText(text: string): Promise<void> {
  const desktop = window.folioDesktop;
  if (desktop) return void (await desktop.copyText(text));
  await navigator.clipboard.writeText(text);
}

/** Copies a PNG image. Rejects if it could not be placed on the system clipboard. */
export async function copyImage(blob: Blob): Promise<void> {
  const desktop = window.folioDesktop;
  if (desktop) {
    // Electron's main process takes the same data URL the viewer's canvas already produces.
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image."));
      reader.readAsDataURL(blob);
    });
    if (!(await desktop.copyImage(dataUrl))) throw new Error("Couldn't copy the image.");
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
