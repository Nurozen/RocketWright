/** Tests only: a blur that the window losing focus caused (a native dialog opening, another app coming forward). */
import { act } from "react";
import { vi } from "vitest";

export async function blurFromWindow(field: HTMLElement): Promise<void> {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await act(async () => field.blur());
  hasFocus.mockRestore();
}
