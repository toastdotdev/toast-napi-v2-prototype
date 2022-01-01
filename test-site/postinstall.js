#!/usr/bin/env node
import { install, printStats } from "esinstall";
import prettyBytes from "pretty-bytes";
import cTable from "console.table";
import { options, specs } from "./esinstall.js";

async function main() {
  const { success, stats } = await install(specs, {
    dest: "./public/web_modules",
    ...options,
  });
  if (stats) {
    console.table(
      Object.entries(stats.direct)
        .map(([key, value]) => ({
          esm: key,
          ...Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, prettyBytes(v)])
          ),
        }))
        .concat(
          Object.entries(stats.common).map(([key, value]) => ({
            esm: key,
            ...Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, prettyBytes(v)])
            ),
          }))
        )
    );
  }
}

try {
  main();
} catch (e) {
  throw e;
}
