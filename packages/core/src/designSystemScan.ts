/**
 * Scans each of VleConfig.uiDirs's index.ts barrel (e.g. components/ui/,
 * and — if it exists — an agent-generated components/ui-kit/, see
 * chatRunner.ts's role in DesignSystemPanel.tsx) for the site's
 * design-system palette — no manual curation, whatever's re-exported as a
 * default there IS the design system, by convention already established in
 * this codebase (see patch.ts's className refusal for shared components:
 * these are exactly the "reusable, used everywhere" pieces).
 */
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import fs from "node:fs";
import path from "node:path";
import type { VleConfig } from "./config";

const traverse: typeof import("@babel/traverse").default =
  (traverseModule as any).default ?? (traverseModule as any);

const BARREL = "index.ts";

export interface DesignSystemComponent {
  name: string;
  dir: string;
  hasChildren: boolean;
  description?: string;
}

/** The /** ... *\/ JSDoc block immediately preceding `function Name`/`const Name` — best-effort, not present on every component. */
function extractDescription(source: string, name: string): string | undefined {
  const declRegex = new RegExp(`(?:function|const)\\s+${name}\\b`);
  const declMatch = declRegex.exec(source);
  if (!declMatch) return undefined;

  const before = source.slice(0, declMatch.index);
  const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = jsdocRegex.exec(before)) !== null) last = m;
  if (!last || last.index == null) return undefined;

  // Only count it if it's immediately above the declaration, not some
  // unrelated earlier comment in the file.
  if (declMatch.index - (last.index + last[0].length) > 200) return undefined;

  return last[1]
    .split("\n")
    .map((l: string) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function scanDir(projectRoot: string, dir: string): DesignSystemComponent[] {
  const barrelPath = path.join(projectRoot, dir, BARREL);
  if (!fs.existsSync(barrelPath)) return [];

  let ast: ReturnType<typeof parser.parse>;
  try {
    ast = parser.parse(fs.readFileSync(barrelPath, "utf8"), { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return [];
  }

  const entries: Array<{ name: string; relFile: string }> = [];
  traverse(ast, {
    ExportNamedDeclaration(nodePath: any) {
      const node = nodePath.node as t.ExportNamedDeclaration;
      if (node.exportKind === "type" || !node.source) return;
      for (const spec of node.specifiers) {
        if (!t.isExportSpecifier(spec)) continue;
        if (spec.local.name !== "default") continue; // only default re-exports are components — named ones aren't droppable visual elements
        const exportedName = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
        entries.push({ name: exportedName, relFile: node.source.value });
      }
    },
  });

  const components: DesignSystemComponent[] = [];
  for (const entry of entries) {
    const componentPath = path.join(projectRoot, dir, `${entry.relFile.replace(/^\.\//, "")}.tsx`);
    if (!fs.existsSync(componentPath)) continue;
    const source = fs.readFileSync(componentPath, "utf8");
    components.push({
      name: entry.name,
      dir,
      hasChildren: /\{\s*(props\.)?children\s*\}/.test(source),
      description: extractDescription(source, entry.name),
    });
  }

  return components;
}

export function scanDesignSystem(config: VleConfig): DesignSystemComponent[] {
  return config.uiDirs.flatMap((dir) => scanDir(config.projectRoot, dir));
}
