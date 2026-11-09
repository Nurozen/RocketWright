/**
 * The agent pane's drop listener (R3.1). The pane is a separate view showing
 * Lecturn's page, so a file dropped on it never reaches the RocketWright
 * page's `useFileDrop`. Main adds this to the guest's session
 * (`registerPreloadScript`, `startPane` in `main.ts`); Lecturn's helper keeps
 * its own preload and every key that decides what the guest can reach.
 *
 * It runs in the guest's isolated world and exposes nothing: no
 * `contextBridge`, so the page still has no `rwDesktop`, and the page's script
 * cannot reach `ipcRenderer` or `webUtils`. A script-made event is
 * `isTrusted: false` and ignored; main checks what is left (`guestDrop` in
 * `lecturn.ts`).
 *
 * Every other file stays Lecturn's: the composer's own handlers run as they
 * always did. A sandboxed preload is a plain CommonJS script, so this file has
 * no imports or exports and uses only erasable TypeScript (see `preload.ts`).
 */
(() => {
  const { ipcRenderer, webUtils } = require("electron") as typeof import("electron");
  // Copies of `PANE_GUEST_DROP_CHANNEL` and `PANE_DROP_NAME`; `paneDropPreload.test.ts` holds them to the contract.
  const CHANNEL = "lecturn-embed:rw-guest-drop";
  const IMPORTABLE = /\.(ork|eng|rse)$/i;

  const carriesFiles = (e: DragEvent): boolean => e.isTrusted && e.dataTransfer !== null && e.dataTransfer.types.includes("Files");

  // A drag's file names are hidden until the drop, so every file drag has to be
  // accepted here or the drop never fires outside Lecturn's own drop targets.
  // Lecturn's handlers still run after this and set their own effect. A drop
  // nothing takes does nothing: `navigateOnDragDrop` is off in this view.
  const accept = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  };

  const isFolder = (item: DataTransferItem): boolean => item.webkitGetAsEntry()?.isDirectory === true;

  const drop = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    const transfer = e.dataTransfer!;
    const files = Array.from(transfer.files);
    if (files.length === 0 || !files.every((f) => IMPORTABLE.test(f.name)) || Array.from(transfer.items).some(isFolder)) return;
    const paths = files.map((f) => webUtils.getPathForFile(f));
    if (paths.includes("")) return; // Not on disk (dragged out of a page): only Lecturn can use it.
    e.preventDefault();
    e.stopImmediatePropagation();
    // Lecturn's drop-target highlight clears on `drop`, which it will not see now.
    e.target?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    ipcRenderer.send(CHANNEL, { paths });
  };

  // Capture on window, registered before the page's scripts run, so this sees each event first.
  window.addEventListener("dragenter", accept, true);
  window.addEventListener("dragover", accept, true);
  window.addEventListener("drop", drop, true);
})();
