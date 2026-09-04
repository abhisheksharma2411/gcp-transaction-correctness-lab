import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(here, "..", "results");

/** Persist raw evidence for each test so the article can quote real output. */
export function writeResult(name: string, payload: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `${name}.json`),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
}
