#!/usr/bin/env node
import { main } from "./cli/program.js";

await main(process.argv.slice(2));
