import { describe, expect, it } from "vitest";
import { mergeReports, parseLcov, summarize, total } from "../../scripts/lcov";

const vitest = `TN:
SF:src/a.ts
FN:1,first
FN:5,second
FNDA:1,first
FNDA:0,second
FNF:2
FNH:1
DA:1,1
DA:2,0
DA:3,0
BRDA:2,0,0,1
BRDA:2,0,1,-
end_of_record
`;
const bun = `TN:
SF:/repo/src/a.ts
FNF:2
FNH:2
DA:1,3
DA:2,4
DA:4,0
LF:3
LH:2
end_of_record
SF:/repo/src/b.ts
FNF:1
FNH:0
DA:1,0
end_of_record
`;

describe("LCOV merge", () => {
  it("leaves out V8 branches for files only Bun executed", () => {
    const unexecuted = vitest.replace("DA:1,1", "DA:1,0").replace("BRDA:2,0,0,1", "BRDA:2,0,0,-");
    const merged = mergeReports([
      parseLcov(unexecuted, "/repo", { statementLines: true }),
      parseLcov(bun, "/repo"),
    ]);
    expect(summarize(merged.get("src/a.ts")!).branches).toEqual({ covered: 0, total: 0 });
    // A file neither suite ran keeps its branches as uncovered.
    const alone = mergeReports([parseLcov(unexecuted, "/repo", { statementLines: true })]);
    expect(summarize(alone.get("src/a.ts")!).branches).toEqual({ covered: 0, total: 2 });
  });

  it("counts only V8 statement lines when a file has them, in either order", () => {
    const options = { statementLines: true };
    for (const reports of [
      [parseLcov(vitest, "/repo", options), parseLcov(bun, "/repo")],
      [parseLcov(bun, "/repo"), parseLcov(vitest, "/repo", options)],
    ]) {
      const merged = mergeReports(reports);
      // Line 4 is a Bun-only listing (e.g. a case label); line 3 is a real uncovered statement.
      expect(summarize(merged.get("src/a.ts")!).lines).toEqual({ covered: 2, total: 3 });
      // Files V8 never loaded keep Bun's lines.
      expect(summarize(merged.get("src/b.ts")!).lines).toEqual({ covered: 0, total: 1 });
    }
  });

  it("normalizes paths and unions lines with max hits", () => {
    const merged = mergeReports([parseLcov(vitest, "/repo"), parseLcov(bun, "/repo")]);
    expect([...merged.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    const a = summarize(merged.get("src/a.ts")!);
    expect(a.lines).toEqual({ covered: 2, total: 4 });
    expect(a.branches).toEqual({ covered: 1, total: 2 });
    // Bun has only totals; its better ratio wins over V8's per-function names.
    expect(a.functions).toEqual({ covered: 2, total: 2 });
  });

  it("keeps per-function V8 data when it is the better ratio and totals across files", () => {
    const merged = mergeReports([
      parseLcov(bun.replace("FNH:2", "FNH:1"), "/repo"),
      parseLcov(vitest.replace("FNDA:0,second", "FNDA:2,second"), "/repo"),
    ]);
    const summaries = [...merged.values()].map(summarize);
    expect(summaries[0]?.functions).toEqual({ covered: 2, total: 2 });
    expect(total(summaries)).toEqual({
      lines: { covered: 2, total: 5 },
      functions: { covered: 2, total: 3 },
      branches: { covered: 1, total: 2 },
    });
  });
});
