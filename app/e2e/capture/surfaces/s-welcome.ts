/** B3 `s-welcome`: a zero-project launch on the seeded profile (three Recents, one missing). */
import { settle, type DriveContext } from "../hooks.ts";
import { welcomeWithRecents } from "./common.ts";

export default async function drive({ page }: DriveContext): Promise<unknown> {
  const recents = await welcomeWithRecents(page);
  await settle(page);
  return { state: { recents } };
}
