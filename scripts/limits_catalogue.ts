// Writes docs/final-dev/LIMITS-CATALOGUE.md from src/lib/limits.ts (A6). usage: pnpm exec tsx scripts/limits_catalogue.ts
import { writeFileSync } from "node:fs";
import { limitsCatalogueMarkdown } from "../src/lib/limits-catalogue";

writeFileSync("docs/final-dev/LIMITS-CATALOGUE.md", limitsCatalogueMarkdown());
console.log("docs/final-dev/LIMITS-CATALOGUE.md written");
