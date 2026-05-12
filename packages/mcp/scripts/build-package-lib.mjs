import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_FACADES = [
  {
    packageName: "@martin/contracts",
    sourceDir: ["packages", "contracts", "dist"],
    targetDir: ["dist", "vendor", "contracts"],
  },
  {
    packageName: "@martin/core",
    sourceDir: ["packages", "core", "dist"],
    targetDir: ["dist", "vendor", "core"],
  },
  {
    packageName: "@martin/policy",
    sourceDir: ["packages", "policy", "dist"],
    targetDir: ["dist", "vendor", "policy"],
  },
  {
    packageName: "@martin/headlessos-core",
    sourceDir: ["packages", "headlessos-core", "dist"],
    targetDir: ["dist", "vendor", "headlessos-core"],
  },
  {
    packageName: "@martin/audit-exporter",
    sourceDir: ["packages", "audit-exporter", "dist"],
    targetDir: ["dist", "vendor", "audit-exporter"],
  },
  {
    packageName: "@martin/adapters",
    sourceDir: ["packages", "adapters", "dist"],
    targetDir: ["dist", "vendor", "adapters"],
  },
];

const PACKAGE_ASSETS = [
  {
    sourceDir: ["packages", "policy", "policies"],
    targetDir: ["dist", "vendor", "policies"],
  },
];

const REWRITABLE_PACKAGES = {
  "@martin/contracts": "contracts",
  "@martin/core": "core",
  "@martin/policy": "policy",
  "@martin/headlessos-core": "headlessos-core",
  "@martin/audit-exporter": "audit-exporter",
  "@martin/adapters": "adapters",
};

export async function buildStandaloneMcpPackage(options = {}) {
  const packageDir = path.resolve(options.packageDir ?? fileURLToPath(new URL("..", import.meta.url)));
  const rootDir = path.resolve(options.rootDir ?? path.join(packageDir, "..", ".."));
  const distDir = path.join(packageDir, "dist");

  await ensureWorkspaceArtifacts(rootDir);
  await rm(distDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  await runCommand(pnpmCommand(), ["exec", "tsc", "-p", "tsconfig.build.json"], { cwd: packageDir });

  await rewriteDirectory({
    currentDir: distDir,
    distDir,
    skipDirs: new Set(["vendor"]),
  });

  for (const facade of PACKAGE_FACADES) {
    await copyFacadeDirectory({
      sourceDir: path.join(rootDir, ...facade.sourceDir),
      targetDir: path.join(packageDir, ...facade.targetDir),
      distDir,
    });
  }

  for (const asset of PACKAGE_ASSETS) {
    await copyRawDirectory({
      sourceDir: path.join(rootDir, ...asset.sourceDir),
      targetDir: path.join(packageDir, ...asset.targetDir),
    });
  }

  await chmod(path.join(distDir, "server.js"), 0o755);

  return {
    packageDir,
    distDir,
    vendorDir: path.join(distDir, "vendor"),
  };
}

async function ensureWorkspaceArtifacts(rootDir) {
  for (const facade of PACKAGE_FACADES) {
    await runCommand(
      pnpmCommand(),
      workspaceBuildCommandArgs(facade.packageName),
      { cwd: rootDir },
    );
  }
}

export function workspaceBuildCommandArgs(packageName) {
  return ["--filter", packageName, "build"];
}

async function copyFacadeDirectory(input) {
  await copyDirectory({
    sourceDir: input.sourceDir,
    targetDir: input.targetDir,
    distDir: input.distDir,
    relativeDir: "",
  });
}

async function copyRawDirectory(input) {
  const sourceStats = await stat(input.sourceDir).catch(() => null);
  if (!sourceStats?.isDirectory()) {
    return;
  }

  await mkdir(input.targetDir, { recursive: true });

  const entries = await readdir(input.sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(input.sourceDir, entry.name);
    const targetPath = path.join(input.targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyRawDirectory({
        sourceDir: sourcePath,
        targetDir: targetPath,
      });
      continue;
    }

    await copyFile(sourcePath, targetPath);
  }
}

async function copyDirectory(input) {
  await mkdir(input.targetDir, { recursive: true });

  const entries = await readdir(input.sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = input.relativeDir
      ? path.join(input.relativeDir, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, relativePath)) {
        continue;
      }

      await copyDirectory({
        sourceDir: path.join(input.sourceDir, entry.name),
        targetDir: path.join(input.targetDir, entry.name),
        distDir: input.distDir,
        relativeDir: relativePath,
      });
      continue;
    }

    if (shouldSkipFile(entry.name)) {
      continue;
    }

    const sourcePath = path.join(input.sourceDir, entry.name);
    const targetPath = path.join(input.targetDir, entry.name);

    if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      const contents = await readFile(sourcePath, "utf8");
      const rewritten = rewritePackageSpecifiers(contents, {
        targetPath,
        distDir: input.distDir,
      });
      await writeFile(targetPath, rewritten, "utf8");
      continue;
    }

    await copyFile(sourcePath, targetPath);
  }
}

async function rewriteDirectory(input) {
  const entries = await readdir(input.currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(input.currentDir, entry.name);

    if (entry.isDirectory()) {
      if (input.skipDirs.has(entry.name)) {
        continue;
      }
      await rewriteDirectory({
        ...input,
        currentDir: entryPath,
      });
      continue;
    }

    if (entry.name.endsWith(".map")) {
      await rm(entryPath, { force: true });
      continue;
    }

    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
      continue;
    }

    const contents = await readFile(entryPath, "utf8");
    const rewritten = rewritePackageSpecifiers(contents, {
      targetPath: entryPath,
      distDir: input.distDir,
    });

    if (rewritten !== contents) {
      await writeFile(entryPath, rewritten, "utf8");
    }
  }
}

function shouldSkipDirectory(name, relativePath) {
  return name === "tests" || relativePath === "src";
}

function shouldSkipFile(name) {
  return name.endsWith(".map");
}

export function rewritePackageSpecifiers(contents, input) {
  return contents.replace(
    /(['"])(@martin\/(?:contracts|core|policy|headlessos-core|audit-exporter|adapters)(?:\/[^'"]+)?)\1/g,
    (_match, quote, packageName) => {
      const parts = packageName.split("/");
      const basePackageName = parts.slice(0, 2).join("/");
      const subpath = parts.slice(2).join("/");
      const mapped = REWRITABLE_PACKAGES[basePackageName];
      if (!mapped) {
        return `${quote}${packageName}${quote}`;
      }

      const normalizedSubpath = subpath
        ? (subpath.endsWith(".js") ? subpath : `${subpath}.js`)
        : "index.js";
      const targetFile = subpath
        ? path.join(input.distDir, "vendor", mapped, normalizedSubpath)
        : path.join(input.distDir, "vendor", mapped, "index.js");
      const specifier = toImportSpecifier(path.dirname(input.targetPath), targetFile);

      return `${quote}${specifier}${quote}`;
    },
  );
}

function toImportSpecifier(fromDir, toFile) {
  const relativePath = path.relative(fromDir, toFile).split(path.sep).join("/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const launch = createCommandLaunch(command, args);
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code ?? "unknown"}): ${command} ${args.join(" ")}`));
        return;
      }
      resolve();
    });
  });
}

export function createCommandLaunch(command, args, platform = process.platform) {
  if (platform !== "win32") {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", toCmdCommand(command, args)],
  };
}

function toCmdCommand(command, args) {
  return [quoteForCmdArgument(command), ...args.map((arg) => quoteForCmdArgument(arg))].join(" ");
}

function quoteForCmdArgument(value) {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
