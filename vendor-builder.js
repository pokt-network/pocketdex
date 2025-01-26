const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const os = require("os");
const tarStream = require("tar-stream"); // Use this to parse the tarball
const zlib = require("zlib");

// Command-line arguments
const args = process.argv.slice(2);
const ONLY_ERRORS = args.includes("--only-errors");

// Configuration file location
const CONFIG_FILE = "./vendor-config.yaml";
let config;
let backupDirs = []; // Tracks directories to back up for rollback
let useDebugDir = !!process.env.DEBUG_UNPACK_DIR; // Check if DEBUG_UNPACK_DIR is specified
const DEBUG_UNPACK_DIR = useDebugDir ? path.resolve(process.env.DEBUG_UNPACK_DIR) : null; // Debug folder location

/**
 * Utility function to log messages
 * @param {string} level - Log level (INFO, WARN, ERROR)
 * @param {string} message - Log message
 */
function log(level, message) {
  if (!ONLY_ERRORS || level === "ERROR" || level === "WARN") {
    console.log(`[${level}] ${message}`);
  }
}

/**
 * Executes a shell command
 * @param {string} command - The command to execute
 * @param {string} cwd - The working directory
 * @param {boolean} suppressLogs - Whether to suppress logs for this command
 */
function runCommand(command, cwd, suppressLogs = false) {
  try {
    log("INFO", `Running: ${command} in ${cwd}`);
    execSync(command, {
      cwd,
      stdio: suppressLogs ? "pipe" : "inherit", // Suppress logs if suppressLogs is true, otherwise inherit terminal
      env: { ...process.env, NODE_ENV: "production" },
    });
  } catch (error) {
    const errorMessage = suppressLogs
      ? error.stderr.toString() || error.message
      : error.message;

    throw new Error(`Command failed: ${command} in ${cwd} - ${errorMessage}`);
  }
}

/**
 * Backs up a directory and stores backups for rollback
 * @param {string} dirPath - Directory path to back up
 * @returns {string|null} - Backup path if backed up or null if no backup was needed
 */
function backupDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    log("INFO", `No backup needed; directory does not exist: ${dirPath}`);
    return null;
  }

  const backupPath = path.join(os.tmpdir(), `backup_${path.basename(dirPath)}_${Date.now()}`);
  fs.cpSync(dirPath, backupPath, { recursive: true });
  backupDirs.push({ original: dirPath, backup: backupPath });
  log("INFO", `Backup created for ${dirPath} at ${backupPath}`);
  return backupPath;
}

/**
 * Rollback changes by restoring backups
 */
function rollback() {
  log("INFO", "Starting rollback process...");
  for (const { original, backup } of backupDirs) {
    if (fs.existsSync(backup)) {
      if (fs.existsSync(original)) {
        fs.rmSync(original, { recursive: true, force: true });
      }

      try {
        fs.cpSync(backup, original, { recursive: true });
        log("INFO", `Restored backup from ${backup} to ${original}`);
      } catch (error) {
        log("ERROR", `Failed to restore backup for ${original}: ${error.message}`);
      }

      try {
        fs.rmSync(backup, { recursive: true, force: true });
        log("INFO", `Cleaned up temporary backup: ${backup}`);
      } catch (cleanupError) {
        log("WARN", `Failed to clean up temporary backup: ${backup} - ${cleanupError.message}`);
      }
    }
  }
  log("INFO", "Rollback process completed.");
}

/**
 * Extracts the name of the package from the package.json inside the tarball
 * @param {string} tarballPath - Path to the package tarball file (.tgz)
 * @returns {Promise<string>} - The name of the package (e.g., "@cosmjs/amino")
 */
function extractPackageNameFromTarball(tarballPath) {
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    const stream = fs.createReadStream(tarballPath).pipe(zlib.createGunzip());

    extract.on("entry", (header, stream, next) => {
      if (header.name === "package/package.json") {
        let data = "";
        stream.on("data", chunk => {
          data += chunk.toString();
        });
        stream.on("end", () => {
          try {
            const packageJson = JSON.parse(data);
            resolve(packageJson.name);
          } catch (e) {
            reject(new Error("Failed to parse package.json from tarball"));
          }
        });
      } else {
        // Skip other files
        stream.resume();
      }
      next();
    });

    extract.on("finish", () => {
      reject(new Error("package.json not found in tarball"));
    });

    stream.pipe(extract);
  });
}

/**
 * Unpacks a tarball into the specified target directory, respecting DEBUG_UNPACK_DIR.
 * @param {string} tarballPath - Path to the tarball.
 * @param {string} target - Target base directory where package should be unpacked.
 */
async function unpackTarball(tarballPath, target) {
  // If DEBUG_UNPACK_DIR is enabled, ensure everything is unpacked under it
  const baseDir = useDebugDir ? DEBUG_UNPACK_DIR : path.resolve();

  // Resolve the full target directory
  const resolvedTargetBaseDir =
    target === "$$ROOT"
      ? path.join(baseDir, "./node_modules") // $$ROOT resolves to node_modules at debug root
      : path.join(baseDir, target, "node_modules"); // Other targets resolve with their paths under the debug dir

  // Extract the package name from the tarball file
  const packageName = await extractPackageNameFromTarball(tarballPath);

  // Generate the final directory path (supporting scoped packages, e.g., @org/package)
  const resolvedTargetDir = path.join(resolvedTargetBaseDir, ...packageName.split("/"));

  // Ensure the directory structure exists
  log("DEBUG", `Ensuring directory exists: ${resolvedTargetDir}`);
  fs.mkdirSync(resolvedTargetDir, { recursive: true });

  // Perform the unpacking
  log("INFO", `Unpacking ${tarballPath} into ${resolvedTargetDir}`);
  try {
    const cwd = path.dirname(tarballPath); // Ensure the working directory is correct
    runCommand(`tar -xzf ${tarballPath} --strip-components=1 -C ${resolvedTargetDir}`, cwd);
  } catch (error) {
    log("ERROR", `Failed to unpack ${tarballPath} into ${resolvedTargetDir}: ${error.message}`);
    throw error;
  }
}

/**
 * Processes all vendors in two phases:
 * 1. Install everything upfront to avoid overwriting during unpack
 * 2. Process build, pack and unpack for each vendor
 * @param {Array} vendors - Array of vendor configurations
 * @param {string} tempDir - Temporary directory for packaging
 */
async function processVendors(vendors, tempDir) {
  log("INFO", "Starting vendor processing in two phases.");

  // Phase 1: Install all dependencies
  log("INFO", "Phase 1: Installing all vendor dependencies.");
  for (const vendor of vendors) {
    const { name, path: vendorPath, install } = vendor;

    if (install?.required) {
      log("INFO", `Installing dependencies for vendor: ${name}`);
      const absolutePath = path.resolve(vendorPath);

      // Ensure we suppress logs during installation
      try {
        runCommand(install.script || "yarn install", absolutePath, true); // Suppress logs
      } catch (error) {
        log("ERROR", `Failed to install dependencies for vendor "${name}": ${error.message}`);
        throw error;
      }
    }
  }

  // Phase 2: Build, Pack, and Unpack for all vendors
  log("INFO", "Phase 2: Processing build, pack, and unpack for all vendors.");
  for (const vendor of vendors) {
    const { name, path: vendorPath, build, pack, unpack } = vendor;

    log("INFO", `Processing vendor: ${name}`);
    const absolutePath = path.resolve(vendorPath);
    const packagesDir = path.join(absolutePath, "packages");

    try {
      // Step 2.1: Build the vendor, if required
      if (build?.required) {
        log("INFO", `Building ${name}`);
        runCommand(build.script || "yarn build", absolutePath, true); // Command execution
      }

      // Step 2.2: Pack the vendor packages
      if (pack?.required) {
        const includedPackages = pack.include || [];
        const packages = fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : [];

        for (const pkgName of packages) {
          if (includedPackages.length > 0 && !includedPackages.includes(pkgName)) {
            log("DEBUG", `Skipping package ${pkgName} because it is not included in pack.include`);
            continue;
          }

          const packagePath = path.join(packagesDir, pkgName);
          const packageJsonPath = path.join(packagePath, "package.json");

          if (!fs.existsSync(packageJsonPath)) {
            log("WARN", `Skipping ${pkgName}: package.json not found`);
            continue;
          }

          const { name: pkgNameJson, version } = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
          const sanitizedName = pkgNameJson.replace(/\//g, "-");
          const tarballName = `${sanitizedName}-${version}.tgz`;
          const tarballPath = path.join(tempDir, tarballName);

          log("INFO", `Packing ${pkgNameJson} into ${tarballPath}`);
          runCommand(`yarn pack --out ${tarballPath}`, packagePath, true); // Suppress logs

          // Step 2.3: Unpack the tarball into each specified target
          if (unpack?.targets) {
            for (const target of unpack.targets) {
              try {
                await unpackTarball(tarballPath, target);
              } catch (error) {
                log("ERROR", `Failed to unpack tarball for package ${pkgNameJson} into target "${target}": ${error.message}`);
              }
            }
          }
        }
      }
    } catch (error) {
      log("ERROR", `Error processing vendor "${name}": ${error.message}`);
      throw error;
    }
  }
}

/**
 * Main function
 */
async function main() {
  log("INFO", "Loading configuration...");
  if (!fs.existsSync(CONFIG_FILE)) {
    log("ERROR", `Configuration file not found: ${CONFIG_FILE}`);
    process.exit(1);
  }
  config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (!config || !config["vendor-packages"]) {
    log("ERROR", `Invalid configuration: ${CONFIG_FILE}`);
    process.exit(1);
  }

  const tempDir = path.resolve("./temp_tgz");
  fs.mkdirSync(tempDir, { recursive: true });
  if (useDebugDir) fs.mkdirSync(DEBUG_UNPACK_DIR, { recursive: true });

  try {
    await processVendors(config["vendor-packages"], tempDir);
    log("INFO", "All vendors processed successfully!");
  } catch (error) {
    log("ERROR", `An error occurred: ${error.message}`);
    rollback();
    process.exit(1);
  }
}

// Entry point
main();
