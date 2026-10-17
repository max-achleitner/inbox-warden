/**
 * Structured JSON logger.
 * All output goes to stderr (stdout is reserved for MCP stdio transport).
 */

import * as fs from "node:fs";
import { redactLogData, redactString } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let logFileStream: fs.WriteStream | null = null;

/** Configure log level from LOG_LEVEL env var */
export function initLogger(): void {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LEVEL_ORDER) {
    currentLevel = envLevel as LogLevel;
  }

  const logFile = process.env.LOG_FILE;
  if (logFile) {
    logFileStream = fs.createWriteStream(logFile, { flags: "a" });
  }
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
  error?: string;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function emit(entry: LogEntry): void {
  const line = JSON.stringify({
    ...entry,
    data: entry.data ? redactLogData(entry.data) : undefined,
    error: entry.error ? redactString(entry.error) : undefined,
  });
  process.stderr.write(line + "\n");
  if (logFileStream) {
    logFileStream.write(line + "\n");
  }
}

export function debug(event: string, data?: Record<string, unknown>): void {
  if (!shouldLog("debug")) return;
  emit({ timestamp: new Date().toISOString(), level: "debug", event, data });
}

export function info(event: string, data?: Record<string, unknown>): void {
  if (!shouldLog("info")) return;
  emit({ timestamp: new Date().toISOString(), level: "info", event, data });
}

export function warn(event: string, data?: Record<string, unknown>): void {
  if (!shouldLog("warn")) return;
  emit({ timestamp: new Date().toISOString(), level: "warn", event, data });
}

export function error(event: string, data?: Record<string, unknown>, err?: unknown): void {
  if (!shouldLog("error")) return;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    data,
  };
  if (err instanceof Error) {
    entry.error = err.message;
  } else if (err !== undefined) {
    entry.error = String(err);
  }
  emit(entry);
}

export function closeLogger(): void {
  if (logFileStream) {
    logFileStream.end();
    logFileStream = null;
  }
}
