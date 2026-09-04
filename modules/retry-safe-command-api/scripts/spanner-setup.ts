#!/usr/bin/env node
/**
 * Create the emulator instance, database, and schema over the REST API.
 *
 * Deliberately does not touch your gcloud configuration. The emulator needs no
 * credentials, so shelling out to `gcloud config set` only risks leaving a
 * developer's real project pointed at localhost.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emulatorReachable, targetFromEnv, toSpannerError } from "../src/spanner-rest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = targetFromEnv();

async function post(path: string, body: unknown, method = "POST"): Promise<unknown> {
  const res = await fetch(`${target.endpoint}/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw toSpannerError(res.status, text);
  return text ? JSON.parse(text) : {};
}

async function exists(path: string): Promise<boolean> {
  const res = await fetch(`${target.endpoint}/${path}`);
  return res.ok;
}

if (!(await emulatorReachable(target))) {
  const instancePath = `projects/${target.project}/instances/${target.instance}`;
  if (!(await exists(instancePath))) {
    await post(`projects/${target.project}/instances`, {
      instanceId: target.instance,
      instance: {
        config: `projects/${target.project}/instanceConfigs/emulator-config`,
        displayName: "retry-safe lab",
        nodeCount: 1,
      },
    });
    process.stdout.write(`created instance ${target.instance}\n`);
  }
}

const dbPath = `projects/${target.project}/instances/${target.instance}/databases/${target.database}`;
if (!(await exists(dbPath))) {
  await post(`projects/${target.project}/instances/${target.instance}/databases`, {
    createStatement: `CREATE DATABASE \`${target.database}\``,
  });
  process.stdout.write(`created database ${target.database}\n`);
}

const sql = readFileSync(join(here, "..", "infra", "schema.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const current = (await (await fetch(`${target.endpoint}/${dbPath}/ddl`)).json()) as {
  statements?: string[];
};
if ((current.statements?.length ?? 0) === 0) {
  await post(`${dbPath}/ddl`, { statements }, "PATCH");
  process.stdout.write(`applied ${statements.length} DDL statements\n`);
} else {
  process.stdout.write(`schema already present (${current.statements?.length} statements)\n`);
}

process.stdout.write(
  `emulator ready: ${target.endpoint} project=${target.project} instance=${target.instance} database=${target.database}\n`,
);
