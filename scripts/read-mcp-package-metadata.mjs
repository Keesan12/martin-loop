import { readFile } from "node:fs/promises";
import path from "node:path";

const metadataDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : process.cwd();

const packageJsonPath = path.join(metadataDir, "package.json");
const serverJsonPath = path.join(metadataDir, "server.json");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const serverJson = JSON.parse(await readFile(serverJsonPath, "utf8"));
const npmPackage = Array.isArray(serverJson.packages)
  ? serverJson.packages.find((entry) => entry && entry.registryType === "npm")
  : undefined;

if (!npmPackage) {
  throw new Error("server.json is missing an npm package entry.");
}

process.stdout.write(`package_version=${packageJson.version}\n`);
process.stdout.write(`server_version=${serverJson.version}\n`);
process.stdout.write(`package_name=${packageJson.name}\n`);
process.stdout.write(`server_name=${serverJson.name}\n`);
process.stdout.write(`identifier=${npmPackage.identifier}\n`);
