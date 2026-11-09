/**
 * The window with no project showing (R0.2): start one, open one, or pick up a
 * recent one. A browser has no Recents, so the section simply has no rows
 * (R0.12). Every failure lands in the one error line here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecentProject } from "@rw/contracts";
import type { HostApi } from "../host/HostApi.ts";
import type { RpcLike } from "../state/rpc.ts";
import { Banner } from "../ui/Banner.tsx";
import { BRAND } from "./brand.ts";
import { Icon } from "./Icon.tsx";
import { NewProjectDialog, type NewProjectOffer } from "./NewProjectDialog.tsx";
import { errorText, openFolder, openRecent, openSample, RECENT_STATUS_TEXT, recentAge } from "./projectActions.ts";

export interface WelcomeProps {
  client: RpcLike;
  host: HostApi;
  /** Why the window came back here (a failed reopen or open). */
  notice: string | null;
  onOpened: (projectId: string) => void;
}

/** Null: closed. An empty object: plain New project. */
type DialogState = { offer?: NewProjectOffer } | null;

export function Welcome({ client, host, notice, onOpened }: WelcomeProps) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  // The clock for the rows' ages, read when the list is, not on every render.
  const [loadedAt, setLoadedAt] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  // A native picker leaves this page clickable behind it.
  const running = useRef(false);

  const loadRecents = useCallback(
    () =>
      host.recents().then((list) => {
        setRecents(list);
        setLoadedAt(Date.now());
      }),
    [host],
  );
  useEffect(() => {
    loadRecents().catch((e: unknown) => setError(`Could not read recent projects: ${errorText(e)}`));
  }, [loadRecents]);

  const perform = (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setDismissedNotice(notice);
    work()
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => {
        running.current = false;
        setStatus(null);
      });
  };

  const onOpenFolder = () =>
    perform(async () => {
      const dir = await host.pickFolder({ title: "Open folder" });
      if (dir === null) return;
      setStatus("Opening the folder…");
      const outcome = await openFolder(client, dir);
      if (outcome.kind === "opened") onOpened(outcome.project.projectId);
      else if (outcome.kind === "blocked") setError(outcome.message);
      else setDialog({ offer: outcome });
    });

  const onOpenSample = () =>
    perform(async () => {
      setStatus("Creating the sample rocket…");
      onOpened((await openSample(client)).projectId);
    });

  const onOpenRecent = (dir: string) =>
    perform(async () => {
      setStatus("Opening the project…");
      onOpened((await openRecent(client, dir)).projectId);
    });

  const onRemoveRecent = (dir: string) =>
    perform(async () => {
      await host.removeRecent(dir);
      await loadRecents();
    });

  const busy = status !== null;
  const shownNotice = notice !== dismissedNotice ? notice : null;

  return (
    <main className="rw-welcome" data-testid="welcome">
      <header className="rw-welcome__brand">
        <img className="rw-welcome__mark" src={BRAND.mark} alt="" width={64} height={64} />
        <h1 className="rw-welcome__name">{BRAND.name}</h1>
      </header>
      <p className="rw-welcome__tagline">Design, check, and fly model rockets.</p>

      <div className="rw-welcome__actions">
        <button type="button" className="rw-welcome__action" disabled={busy} onClick={() => setDialog({})}>
          <Icon name="file" size={52} />
          New project
        </button>
        <button type="button" className="rw-welcome__action" disabled={busy} onClick={onOpenFolder}>
          <Icon name="folder" size={52} />
          Open folder…
        </button>
        <button type="button" className="rw-welcome__action" disabled={busy} onClick={onOpenSample}>
          <Icon name="rocket" size={52} />
          Open sample rocket
        </button>
      </div>

      <div className="rw-welcome__messages">
        {status !== null && (
          <p className="rw-welcome__status" role="status">
            {status}
          </p>
        )}
        {shownNotice !== null && (
          <Banner tone="warning" testId="welcome.notice" onDismiss={() => setDismissedNotice(shownNotice)}>
            {shownNotice}
          </Banner>
        )}
        {error !== null && (
          <Banner tone="danger" testId="welcome.error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
      </div>

      {recents.length > 0 && (
        <section className="rw-welcome__recent" aria-labelledby="rw-welcome-recent">
          <h2 id="rw-welcome-recent" className="rw-welcome__recent-title">
            Recent
          </h2>
          <ul className="rw-welcome__recent-list">
            {recents.map((recent) => (
              <li key={recent.dir} className="rw-welcome__recent-row" data-status={recent.status}>
                <button type="button" className="rw-welcome__recent-open" disabled={busy || recent.status === "missing"} onClick={() => onOpenRecent(recent.dir)}>
                  <Icon name="rocket" size={24} />
                  <span className="rw-welcome__recent-name">{recent.name}</span>
                  <span className="rw-welcome__recent-path">{recent.dir}</span>
                  <span className="rw-welcome__recent-age">{RECENT_STATUS_TEXT[recent.status] ?? recentAge(recent.lastOpened, loadedAt)}</span>
                </button>
                {recent.status === "missing" && (
                  <button type="button" className="rw-button rw-button--quiet" aria-label={`Remove ${recent.name} from Recent`} disabled={busy} onClick={() => onRemoveRecent(recent.dir)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="rw-welcome__version">{client.hello.coreVersion}</footer>

      {dialog !== null && (
        <NewProjectDialog
          client={client}
          host={host}
          offer={dialog.offer}
          onClose={() => setDialog(null)}
          onCreated={(projectId) => {
            setDialog(null);
            onOpened(projectId);
          }}
        />
      )}
    </main>
  );
}
