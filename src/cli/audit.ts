import { verifyAuditLog, type AuditVerification } from "../audit/audit-log.js";
import { errorMessage } from "../errors.js";
import { t, type Locale } from "./messages.js";

/**
 * Check the audit log at `target` (folder or single month file) and print the result.
 * Returns the exit code: 0 intact, 1 tampered or incomplete, 2 unreadable.
 */
export function runAuditVerify(target: string, locale: Locale, print: (line: string) => void): number {
  let result: AuditVerification;
  try {
    result = verifyAuditLog(target);
  } catch (err) {
    print(t(locale, "auditUnreadable", { path: target, message: errorMessage(err) }));
    return 2;
  }
  if (result.records === 0) {
    print(t(locale, "auditEmpty", { path: target }));
    return 0;
  }
  print(
    t(locale, "auditChecked", {
      records: result.records,
      files: result.files.length,
      first: result.firstSeq ?? 0,
      last: result.lastSeq ?? 0,
    }),
  );
  if (result.anchored) print(t(locale, "auditAnchored"));
  if (result.ok) {
    print(t(locale, "auditOk"));
    print(t(locale, "auditHead", { hash: result.headHash ?? "" }));
    return 0;
  }
  print(t(locale, "auditFailed", { count: result.problems.length }));
  for (const p of result.problems.slice(0, 50)) print(`  ${p.file}:${p.line}  ${p.problem}`);
  return 1;
}
