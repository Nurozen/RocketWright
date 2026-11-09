/**
 * The next step for a project with no threads yet: the embedded pane only
 * says there are none (that line is Lecturn's and offers nothing to do), so a
 * RocketWright strip above the pane starts the first one. While a thread is
 * being made the button says so; a thread that could not be made says why.
 */
import type { ThreadStart } from "../state/types.ts";

export function StartChatPrompt({ start, onStart }: { start: ThreadStart; onStart: () => void }) {
  const starting = start.state === "starting";
  return (
    <div className="rw-start-chat" data-testid="agent.start-chat">
      <p>Start a chat with the agent about this design.</p>
      <button type="button" className="rw-button rw-button--primary" onClick={onStart} disabled={starting} aria-busy={starting}>
        {starting ? "Starting…" : "Start a chat"}
      </button>
      {start.state === "error" && <p role="alert">{start.message}</p>}
    </div>
  );
}
