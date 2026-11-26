import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(rootDir, "src/server/worker/runner.ts")],
  outfile: path.join(rootDir, "dist/worker.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "external",
  tsconfig: path.join(rootDir, "tsconfig.json"),
  sourcemap: true,
  banner: {
    js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__importMetaUrl",
  },
  logLevel: "info",
});
