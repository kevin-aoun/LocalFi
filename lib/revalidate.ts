/**
 * Cache invalidation that cannot turn a successful write into a reported failure.
 *
 * WHY: `revalidatePath` throws "Invariant: static generation store missing" when
 * it is called outside a request scope — from a script, a background job, or a
 * unit test. In every server action that matters here the database write has
 * ALREADY committed by the time revalidation runs, so letting that throw
 * propagate into the action's catch block reports "Failed to create account" for
 * an account that was in fact created. In a finance app the user then retries and
 * double-posts. A stale page is the lesser evil, so revalidation is treated as the
 * hint it is.
 *
 * Call this AFTER the write, never before.
 */
import { revalidatePath } from "next/cache";

export function revalidate(...paths: string[]): void {
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (error) {
      // Outside a request scope (script/test), or Next declined the hint. The
      // data is already persisted; the next full render will pick it up.
      console.debug(`[revalidate] skipped ${path}: ${(error as Error).message}`);
    }
  }
}
