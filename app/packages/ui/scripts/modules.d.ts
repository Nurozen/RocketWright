/** Ambient types for the untyped font tooling (pinned in `SUBSETTER_PINS`). */
declare module "subset-font" {
  interface SubsetFontOptions {
    targetFormat?: "sfnt" | "truetype" | "woff" | "woff2";
    preserveNameIds?: number[];
    keepFeatures?: string[];
    noLayoutClosure?: boolean;
    noHinting?: boolean;
    dropTables?: string[];
  }
  export default function subsetFont(font: Uint8Array, text: string, options?: SubsetFontOptions): Promise<Uint8Array>;
}

declare module "wawoff2" {
  export function compress(sfnt: Uint8Array): Promise<Uint8Array>;
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>;
}
