/**
 * PORTED VERBATIM from agent-shield-scan (scanner-cli/src/top-packages.ts,
 * agent-shield-scan-wt @ scanner-cli 0.3.1) — GUS Phase 4 skill-install
 * gate (foundation spec §1.7, choke point 2). See scanner/types.ts in
 * this directory for the porting note.
 *
 * Bundled top-packages name list for the S10 typosquat prompt (spec §2).
 *
 * This is a SUBSET — the most-installed npm and PyPI names an attacker
 * most plausibly typosquats — bundled so local mode needs no registry
 * lookups. It is not the full top-500; membership only ever produces a
 * low-confidence "confirm this is the package you intend" prompt.
 */
export const TOP_PACKAGES: readonly string[] = [
  // npm — frameworks, tooling, and the most-depended-upon libraries
  "react", "react-dom", "vue", "angular", "svelte", "next", "nuxt",
  "express", "fastify", "koa", "axios", "node-fetch", "got", "request",
  "lodash", "underscore", "ramda", "moment", "dayjs", "date-fns", "uuid",
  "chalk", "commander", "yargs", "debug", "dotenv", "cors", "helmet",
  "morgan", "winston", "pino", "zod", "joi", "yup", "ajv",
  "typescript", "webpack", "vite", "esbuild", "rollup", "babel", "eslint",
  "prettier", "jest", "mocha", "vitest", "chai", "sinon", "nodemon",
  "pm2", "socket.io", "ws", "redis", "ioredis", "mongodb", "mongoose",
  "pg", "mysql2", "sqlite3", "prisma", "sequelize", "knex",
  "jsonwebtoken", "bcrypt", "bcryptjs", "passport", "stripe", "aws-sdk",
  "@modelcontextprotocol/sdk", "openai", "@anthropic-ai/sdk", "langchain",
  "cheerio", "puppeteer", "playwright", "sharp", "canvas", "multer",
  "body-parser", "cookie-parser", "express-session", "graphql", "apollo-server",
  "three", "d3", "tailwindcss", "bootstrap", "jquery", "rxjs", "immer",
  // PyPI — the most-installed Python packages
  "requests", "urllib3", "setuptools", "pip", "wheel", "certifi", "boto3",
  "botocore", "numpy", "pandas", "scipy", "matplotlib", "pillow",
  "flask", "django", "fastapi", "uvicorn", "pydantic", "sqlalchemy",
  "pytest", "tox", "black", "flake8", "mypy", "coverage", "tqdm",
  "pyyaml", "jinja2", "click", "rich", "typer", "httpx", "aiohttp",
  "celery", "redis", "pymongo", "psycopg2", "beautifulsoup4", "lxml",
  "scrapy", "selenium", "openai", "anthropic", "langchain", "transformers",
  "torch", "tensorflow", "scikit-learn", "nltk", "cryptography", "pyjwt",
  "paramiko", "fabric", "ansible", "docker", "kubernetes", "grpcio",
  "protobuf", "six", "python-dateutil", "pytz", "attrs", "packaging",
];

/** Damerau–Levenshtein distance (Levenshtein + adjacent transposition). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3; // early exit: caller only cares <= 1
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/**
 * If `name` is within edit distance 1 of a bundled top package (and is
 * not that package), return the look-alike; otherwise null.
 */
export function typosquatLookalike(name: string): string | null {
  const norm = name.toLowerCase();
  if (norm.length < 4) return null;
  for (const top of TOP_PACKAGES) {
    if (norm === top) return null; // it IS the top package
  }
  for (const top of TOP_PACKAGES) {
    if (Math.abs(top.length - norm.length) > 1) continue;
    if (editDistance(norm, top) <= 1) return top;
  }
  return null;
}
