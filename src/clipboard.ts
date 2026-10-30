// Writing text to the clipboard.
// The desktop shell denies the renderer's Clipboard API: its permission handlers only admit the
// camera, so `navigator.clipboard.writeText` rejects with NotAllowedError. The desktop build
// therefore writes through the main process. The browser build has no shell, so it uses the
// Clipboard API and is subject to the usual gesture and permission rules.
export async function copyText(text: string): Promise<void> {
  const desktop = window.folioDesktop;
  if (desktop) return void (await desktop.copyText(text));
  await navigator.clipboard.writeText(text);
}
