/**
 * Page 06 visual flow transport (M5.3): Play/Pause, the scrubber, the
 * clock (`0.0 s / 10.0 s`), speed 0.5x / 1x / 2x, and the Section view
 * switch. The transport owns the study clock: a rAF loop advances `t` while
 * playing, and every seek (scrub, study change, restart) bumps `seekId` so
 * the GPU liquid re-settles (`FluidStage` reads both through `ClockSource`).
 * The traces' cursors read the same `t` (synced by construction).
 */
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { clockLabel } from "../../fluid/timeline.ts";
import type { ClockSource } from "../../fluid/stage.ts";

export const SPEEDS = [0.5, 1, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export interface TransportState {
  t: number;
  duration: number;
  playing: boolean;
  speed: Speed;
  seekId: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  setSpeed(s: Speed): void;
  setDuration(d: number): void;
  /** Advances by `dt` real seconds while playing; stops at the end. */
  tick(dt: number): void;
}

export type TransportStore = StoreApi<TransportState>;

export function createTransport(duration = 10): TransportStore {
  return createStore<TransportState>()((set, get) => ({
    t: 0,
    duration,
    playing: false,
    speed: 1,
    seekId: 0,
    play: () => {
      const s = get();
      // Play from the start again once the study has ended.
      if (s.t >= s.duration) set({ t: 0, seekId: s.seekId + 1 });
      set({ playing: true });
    },
    pause: () => set({ playing: false }),
    toggle: () => (get().playing ? get().pause() : get().play()),
    seek: (t) => set((s) => ({ t: Math.min(Math.max(t, 0), s.duration), seekId: s.seekId + 1 })),
    setSpeed: (speed) => set({ speed }),
    setDuration: (d) => set((s) => ({ duration: d, t: Math.min(s.t, d), seekId: s.seekId + 1 })),
    tick: (dt) => {
      const s = get();
      if (!s.playing) return;
      const t = s.t + dt * s.speed;
      if (t >= s.duration) set({ t: s.duration, playing: false });
      else set({ t });
    },
  }));
}

/** The stage's view of the transport. */
export const clockOf = (store: TransportStore): ClockSource => ({
  time: () => store.getState().t,
  seekId: () => store.getState().seekId,
});

/** Runs the transport clock on rAF while mounted. */
export function useTransportLoop(store: TransportStore): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      store.getState().tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);
}

const speedLabel = (s: Speed) => `${s}×`;

export function TransportBar({ store, section, onSection }: { store: TransportStore; section: boolean; onSection: (on: boolean) => void }) {
  const t = useStore(store, (s) => s.t);
  const duration = useStore(store, (s) => s.duration);
  const playing = useStore(store, (s) => s.playing);
  const speed = useStore(store, (s) => s.speed);
  const st = store.getState();
  return (
    <div className="rw-transport" data-testid="transport" data-rw-region="transport-bar" data-t={t.toFixed(3)} data-playing={playing} data-speed={speed}>
      <button type="button" className="rw-button rw-transport__play" data-testid="transport.play" aria-pressed={playing} onClick={() => st.toggle()}>
        <svg className="rw-icon" width={16} height={16} viewBox="0 0 20 20" aria-hidden>
          {playing ? <path d="M6 4h3v12H6zM11 4h3v12h-3z" fill="currentColor" /> : <path d="M6 3.5v13l11-6.5z" fill="currentColor" />}
        </svg>
        <span>{playing ? "Pause" : "Play"}</span>
      </button>
      <input
        className="rw-transport__scrub"
        data-testid="transport.scrubber"
        type="range"
        min={0}
        max={duration}
        step={0.05}
        value={t}
        aria-label="Study time"
        style={{ ["--rw-scrub" as string]: `${duration > 0 ? (100 * t) / duration : 0}%` }}
        onChange={(e) => st.seek(Number(e.target.value))}
      />
      <span className="rw-transport__clock" data-testid="transport.clock">
        {clockLabel(t, duration)}
      </span>
      <div className="rw-transport__speeds" role="radiogroup" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" role="radio" className="rw-button rw-transport__speed" data-testid="transport.speed" data-speed={s} aria-checked={s === speed} onClick={() => st.setSpeed(s)}>
            {speedLabel(s)}
          </button>
        ))}
      </div>
      <span className="rw-transport__sep" aria-hidden />
      <label className="rw-transport__section">
        <span className="rw-switch">
          <input type="checkbox" role="switch" data-testid="transport.section" checked={section} onChange={(e) => onSection(e.target.checked)} />
          <span className="rw-switch__track" aria-hidden />
        </span>
        <span>Section view</span>
      </label>
    </div>
  );
}
