/**
 * What the project commands do, for the header menu and the native menu alike:
 * each is guarded against losing typed work, and every failure is shown in the
 * window. Leaving a project goes flush, then the action; Close goes flush,
 * disconnect, close, then the next project or Welcome (D22).
 *
 * Recents are read from the host when the menu opens and recorded through
 * `setActiveProject` by `AppRoot`, never from `project.opened`, which main
 * dedupes.
 */
import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ExportFileRequest, ProjectInfo, RecentProject, schema } from "@rw/contracts";
import type { HostApi } from "../host/HostApi.ts";
import type { RpcLike } from "../state/rpc.ts";
import type { ExportChoices, ExportRunChoice } from "../state/selectors.ts";
import { Banner } from "../ui/Banner.tsx";
import { Modal } from "../ui/Modal.tsx";
import { dispatchCommand, type CommandHandlers } from "./commands.ts";
import type { LifecycleState } from "./lifecycle.ts";
import type { ProjectMenuModel } from "./model.ts";
import { NewProjectDialog, type NewProjectOffer } from "./NewProjectDialog.tsx";
import { ExportDialog, OrkImportDialog } from "./ImportExportDialogs.tsx";
import { defaultUnits, errorText, exportDefaultName, exportedNotice, fileBase, IMPORT_BUSY, IMPORT_FILTERS, IMPORT_MOTOR_NEEDS_PROJECT, IMPORT_UNSUPPORTED, importedNotice, importKindOf, nextOpen, openFolder, openRecent, openSample, ORK_FILTERS, type Notice } from "./projectActions.ts";
import { RenameProjectDialog } from "./RenameProjectDialog.tsx";

/** What `AppRoot` needs from the mounted project before it can leave it. */
export interface SurfaceHandle {
  /** Saves typed work; returns what could not be saved. */
  flush(): Promise<string[]>;
  /** What the Export dialog can offer for this project. */
  exportChoices(): ExportChoices;
  disconnect(): void;
  /** Undoes `disconnect` when the close it was for failed. */
  reconnect(): void;
  /** Lecturn's providers panel, through this project's own pane bridge (browser mode). */
  openProviders(): void;
}

export interface ProjectActionsOptions {
  client: RpcLike | null;
  host: HostApi;
  lifecycle: RefObject<LifecycleState>;
  surface: RefObject<SurfaceHandle | null>;
  /** The shown project's latest name and folder. */
  info: RefObject<ProjectInfo | null>;
  show: (projectId: string) => void;
  closed: (projectId: string, next: string | null) => void;
}

export interface ProjectActions {
  commands: CommandHandlers;
  menu: ProjectMenuModel;
  switchProject: (projectId: string) => void;
  /** Puts a failure from outside these actions in the same place. */
  report: (message: string) => void;
  /** Imports a file named by path, whether picked, dropped or typed (D18). */
  importPath: (path: string) => void;
  /** Floating banners, for the window's banner stack. */
  banners: ReactNode;
  overlays: ReactNode;
}

interface UnsavedQuestion {
  problems: readonly string[];
  answer: (leave: boolean) => void;
}

// A pick from the native Recent menu has no control of its own to stay disabled, so a refusal has to be said.
const RECENT_BUSY = "Could not open the recent project: another project action is still running. Try again when it finishes.";
const RECENT_NOT_CONNECTED = "Could not open the recent project: the window is still connecting. Try again in a moment.";

function UnsavedPrompt({ question }: { question: UnsavedQuestion }) {
  const keep = () => question.answer(false);
  return (
    <Modal
      open
      onClose={keep}
      title="Unsaved changes"
      testId="unsaved-prompt"
      footer={
        <>
          <button type="button" className="rw-button" onClick={keep}>
            Keep editing
          </button>
          <button type="button" className="rw-button rw-button--primary" onClick={() => question.answer(true)}>
            Don't save
          </button>
        </>
      }
    >
      <p>These changes could not be saved:</p>
      <ul>
        {question.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </Modal>
  );
}

export function useProjectActions({ client, host, lifecycle, surface, info, show, closed }: ProjectActionsOptions): ProjectActions {
  const [recents, setRecents] = useState<readonly RecentProject[]>([]);
  const [recentsError, setRecentsError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ offer?: NewProjectOffer; ork?: string } | null>(null);
  const [orkChoice, setOrkChoice] = useState<{ path: string; projectName: string } | null>(null);
  const [exporting, setExporting] = useState<(ExportChoices & { projectId: string; projectName: string }) | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renaming, setRenaming] = useState<ProjectInfo | null>(null);
  const [question, setQuestion] = useState<UnsavedQuestion | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A native picker or an accelerator can ask again while one of these is still running.
  const running = useRef(false);

  const report = useCallback((message: string) => setError(message), []);

  const perform = (work: (rpc: RpcLike) => Promise<void>, onRefused?: () => void) => {
    if (running.current || client === null) {
      onRefused?.();
      return;
    }
    running.current = true;
    setError(null);
    setNotice(null);
    work(client)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => {
        running.current = false;
        setStatus(null);
      });
  };

  /** True when it is safe to leave: everything saved, or the person chose to drop what could not be. */
  const mayLeave = async (): Promise<boolean> => {
    const problems = (await surface.current?.flush()) ?? [];
    if (problems.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      setQuestion({
        problems,
        answer: (leave) => {
          setQuestion(null);
          resolve(leave);
        },
      });
    });
  };

  const leaveThen = (work: (rpc: RpcLike) => Promise<void>, onRefused?: () => void) =>
    perform(async (rpc) => {
      if (await mayLeave()) await work(rpc);
    }, onRefused);

  const close = async (rpc: RpcLike) => {
    const shown = lifecycle.current;
    if (shown.phase !== "project") return;
    if (!(await mayLeave())) return;
    const mounted = surface.current;
    setStatus("Closing the project…");
    mounted?.disconnect();
    try {
      await rpc.call("project.close", { projectId: shown.projectId });
    } catch (e) {
      // Still open on the server: put the window back on it, then say why.
      mounted?.reconnect();
      throw e;
    }
    closed(shown.projectId, await nextOpen(rpc, shown.projectId));
  };

  /** A drop or an accelerator arrives past any dialog on screen, which it must not replace. */
  const dialogOpen = dialog !== null || orkChoice !== null || exporting !== null || renaming !== null || question !== null;

  const importFile = async (rpc: RpcLike, path: string) => {
    const kind = importKindOf(path);
    if (kind === null) {
      setError(IMPORT_UNSUPPORTED);
      return;
    }
    const shown = lifecycle.current;
    if (shown.phase !== "project") {
      if (kind === "motor") setError(IMPORT_MOTOR_NEEDS_PROJECT);
      else setDialog({ ork: path });
      return;
    }
    if (kind === "ork") {
      setOrkChoice({ path, projectName: info.current?.name ?? shown.projectId });
      return;
    }
    setStatus(`Importing ${fileBase(path)}…`);
    setNotice(importedNotice(fileBase(path), await rpc.call("import.file", { projectId: shown.projectId, path, kind })));
  };

  const importPath = (path: string) => {
    if (dialogOpen) setError(IMPORT_BUSY);
    else perform((rpc) => importFile(rpc, path), () => setError(IMPORT_BUSY));
  };

  const replaceWithOrk = (path: string) => {
    setOrkChoice(null);
    // Replacing commits over whatever is on disk, so typed work has to be there first.
    leaveThen(async (rpc) => {
      const shown = lifecycle.current;
      if (shown.phase !== "project") return;
      setStatus(`Importing ${fileBase(path)}…`);
      setNotice(importedNotice(fileBase(path), await rpc.call("import.file", { projectId: shown.projectId, path, kind: "ork" })));
    });
  };

  const newFromOrk = (path: string) => {
    setOrkChoice(null);
    leaveThen(async () => setDialog({ ork: path }));
  };

  const runExport = (format: schema.ExportFormat, run: ExportRunChoice | undefined) => {
    const target = exporting;
    setExporting(null);
    if (target === null) return;
    const { projectId, projectName } = target;
    const selection = run === undefined ? {} : { run: run.ref };
    const request: ExportFileRequest = { projectId, format, defaultName: exportDefaultName(projectName, format, run?.sim), ...selection };
    // An export writes what is saved, so typed work has to be saved first.
    leaveThen(async (rpc) => {
      setStatus("Exporting…");
      const result = await host.exportFile(request, (path) => rpc.call("export.file", { projectId, format, path, ...selection }));
      if (!result.canceled) setNotice(exportedNotice(result.out));
    });
  };

  const commands: CommandHandlers = {
    "file.import": () => {
      if (dialogOpen) {
        setError(IMPORT_BUSY);
        return;
      }
      perform(async (rpc) => {
        // With no project only a design can be imported, so the picker offers only that.
        const path = await host.pickFile({ title: "Import", filters: lifecycle.current.phase === "project" ? IMPORT_FILTERS : ORK_FILTERS });
        if (path !== null) await importFile(rpc, path);
      }, () => setError(IMPORT_BUSY));
    },
    "file.export": () => {
      const shown = lifecycle.current;
      const mounted = surface.current;
      if (shown.phase !== "project" || mounted === null || dialogOpen) return;
      setError(null);
      setNotice(null);
      setExporting({ ...mounted.exportChoices(), projectId: shown.projectId, projectName: info.current?.name ?? shown.projectId });
    },
    "project.new": () => leaveThen(async () => setDialog({})),
    "project.open": () =>
      leaveThen(async (rpc) => {
        const dir = await host.pickFolder({ title: "Open folder" });
        if (dir === null) return;
        setStatus("Opening the folder…");
        const outcome = await openFolder(rpc, dir);
        if (outcome.kind === "opened") show(outcome.project.projectId);
        else if (outcome.kind === "blocked") setError(outcome.message);
        else setDialog({ offer: outcome });
      }),
    "project.openSample": () =>
      leaveThen(async (rpc) => {
        setStatus("Creating the sample rocket…");
        show((await openSample(rpc, await defaultUnits(host))).projectId);
      }),
    "project.openRecent": ({ dir }) =>
      leaveThen(async (rpc) => {
        setStatus("Opening the project…");
        show((await openRecent(rpc, dir)).projectId);
      }, () => setError(client === null ? RECENT_NOT_CONNECTED : RECENT_BUSY)),
    "project.rename": () => {
      const shown = lifecycle.current;
      if (shown.phase === "project" && info.current?.projectId === shown.projectId) setRenaming(info.current);
    },
    "project.close": () => perform(close),
  };

  const menu: ProjectMenuModel = {
    recents,
    errors: recentsError === null ? [] : [recentsError],
    onOpen: () => {
      host.recents().then(
        (list) => {
          setRecents(list);
          setRecentsError(null);
        },
        (e: unknown) => setRecentsError(`Could not read recent projects: ${errorText(e)}`),
      );
    },
    onCommand: (command) => void dispatchCommand(command, commands),
    onRemoveRecent: (dir) => perform(() => host.removeRecent(dir)),
  };

  const switchProject = (projectId: string) => leaveThen(async () => show(projectId));

  const banners = (
    <>
      {status !== null && (
        <Banner floating testId="project-actions.status">
          {status}
        </Banner>
      )}
      {error !== null && (
        <Banner floating tone="danger" testId="project-actions.error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice !== null && (
        <Banner floating tone={notice.tone} testId="project-actions.notice" onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}
    </>
  );

  const overlays = (
    <>
      {question !== null && <UnsavedPrompt question={question} />}
      {client !== null && dialog !== null && (
        <NewProjectDialog
          client={client}
          host={host}
          offer={dialog.offer}
          ork={dialog.ork}
          onClose={() => setDialog(null)}
          onCreated={(projectId) => {
            setDialog(null);
            show(projectId);
          }}
        />
      )}
      {client !== null && renaming !== null && <RenameProjectDialog client={client} project={renaming} onClose={() => setRenaming(null)} />}
      {orkChoice !== null && <OrkImportDialog fileName={fileBase(orkChoice.path)} projectName={orkChoice.projectName} onCancel={() => setOrkChoice(null)} onNew={() => newFromOrk(orkChoice.path)} onReplace={() => replaceWithOrk(orkChoice.path)} />}
      {exporting !== null && <ExportDialog choices={exporting} onCancel={() => setExporting(null)} onExport={runExport} />}
    </>
  );

  return { commands, menu, switchProject, report, importPath, banners, overlays };
}
