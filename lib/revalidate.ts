
import { revalidatePath } from "next/cache";

export function revalidate(...paths: string[]): void {
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (error) {

      console.debug(`[revalidate] skipped ${path}: ${(error as Error).message}`);
    }
  }
}
