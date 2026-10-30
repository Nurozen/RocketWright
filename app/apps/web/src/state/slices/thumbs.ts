/**
 * `thumbs` (M3.6, U14): rendered part thumbnails of the committed model,
 * keyed by `thumbKey(id, variant)` and cached server-side by
 * `(model_hash, id)` in `.rw/cache/thumbs/`. The window renders what the
 * cache lacks (`render/thumbnails.ts`, `ThumbnailBaker`) and stores it back.
 * Visual tier (I13): pictures only, never model data.
 */
import type { SliceCtx, ThumbsSlice } from "../types.ts";

const dataUrl = (png: string) => `data:image/png;base64,${png}`;

export const EMPTY_THUMBS = { hash: null, urls: {}, rendered: [] } as const;

export function createThumbsSlice(ctx: SliceCtx): ThumbsSlice {
  return {
    hash: null,
    urls: {},
    rendered: [],
    async load(hash) {
      if (ctx.get().thumbs.hash !== hash) ctx.patch("thumbs", { hash, urls: {}, rendered: [] });
      const { client, projectId } = ctx.conn();
      const r = await client.call("thumb.get", { projectId, model_hash: hash });
      if (ctx.get().thumbs.hash !== hash) return;
      const urls: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.thumbs)) urls[k] = dataUrl(v);
      ctx.patch("thumbs", (t) => ({ urls: { ...urls, ...t.urls } }));
    },
    async add(hash, key, png) {
      if (ctx.get().thumbs.hash !== hash) return;
      ctx.patch("thumbs", (t) => ({ urls: { ...t.urls, [key]: dataUrl(png) }, rendered: t.rendered.includes(key) ? t.rendered : [...t.rendered, key] }));
      if (ctx.client === null || ctx.projectId === null) return;
      // Best effort: a failed cache write only costs a re-render next time.
      await ctx.client.call("thumb.put", { projectId: ctx.projectId, model_hash: hash, id: key, png_base64: png }).catch(() => undefined);
    },
  };
}
