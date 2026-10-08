// Prerequisite check: `bun scripts/doctor.ts`. Exits 1 when a required check fails.
import { runDoctor, type DoctorCheck } from "../src/doctor";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const MARKS: Record<DoctorCheck["status"], string> = {
  ok: paint("32", "✓"),
  warn: paint("33", "!"),
  error: paint("31", "✗"),
  skip: paint("90", "–"),
};

const { checks, backends } = await runDoctor({ fresh: true });

for (const c of checks) {
  const tag = c.required ? "" : paint("90", " (optional)");
  console.log(`${MARKS[c.status]} ${c.label}${tag}: ${c.detail}`);
  if (c.fix && c.status !== "ok" && c.status !== "skip") console.log(`    ${paint("36", "fix:")} ${c.fix}`);
}

const blockers = checks.filter((c) => c.required && c.status === "error");
console.log(`\nBackends: ${backends.join(", ")}`);
if (blockers.length > 0) {
  console.log(paint("31", `${blockers.length} required check(s) failed: ${blockers.map((c) => c.id).join(", ")}`));
  process.exit(1);
}
const warnings = checks.filter((c) => c.status === "warn").length;
console.log(paint("32", warnings > 0 ? `Ready, with ${warnings} warning(s).` : "All checks passed."));
