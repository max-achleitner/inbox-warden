#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { syncVersions } from "./lib/versions.mjs";

syncVersions(fileURLToPath(new URL("..", import.meta.url)));
console.log("Plugin manifest updated to the package version.");
