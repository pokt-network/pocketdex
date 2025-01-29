const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");

const rootDir = process.cwd();
const tempDir = path.resolve(path.join(rootDir, "temp_vendor_builder"));
const CONFIG_FILE = path.resolve(path.join(rootDir, "vendor-config.yaml"));

// Command-line arguments
const args = process.argv.slice(2);
/**
 * A boolean variable that determines whether only error messages should be processed or displayed.
 *
 * The value of this variable is set based on the presence of the "--only-errors" argument
 * in the provided command-line arguments.
 *
 * If "--only-errors" is included in the arguments, ONLY_ERRORS will be set to `true`,
 * indicating that only errors should be considered.
 * Otherwise, it will default to `false`, allowing for additional non-error outputs.
 */
const ONLY_ERRORS = args.includes("--only-errors");
/**
 * A boolean variable indicating whether the application should operate in "dry mode."
 *
 * When set to true, the application will simulate its operations without performing any
 * actual changes or side effects. This mode is typically useful for testing, debugging,
 * or analyzing the application's behavior without impacting real data or producing
 * permanent changes.
 *
 * The value of `DRY_MODE` is determined based on the presence of the `--dry-mode`
 * argument in the runtime arguments (`args`).
 */
const DRY_MODE = args.includes("--dry-mode");
/**
 * A boolean flag indicating whether the debug mode is enabled.
 * When debug is enabled, a `debug_vendors` folder
 * will be created at `cwd` to reflect all the packages extracted in the same structure that will be at root project.
 *
 * This variable is set based on the presence of the "--debug" argument
 * in the application's input arguments.
 * If "--debug" is included in the
 * arguments, `DEBUG` will be `true`.
 * Otherwise, it will be `false`.
 */
const DEBUG = args.includes("--debug");

/**
 * An array used to store a list of backup directory paths.
 * This variable holds the directory paths where backup files
 * or data should be saved or retrieved from.
 *
 * It is initialized as an empty array and can be updated
 * dynamically during runtime based on application needs.
 */
const backupDirs = []; // Tracks directories to back up for rollback


/**
 * Represents a collection of targets associated with different vendors.
 * This object is used to map vendor identifiers to their specific target configurations or data.
 * Each key in the object is expected to represent a unique vendor, and the corresponding value holds the target information.
 */
const vendorTargets = {};
/**
 * An object representing the dependents associated with vendors.
 * This variable is used to store and manage relationships
 * between vendors and their respective dependents.
 *
 * The keys in this object typically represent unique vendor identifiers,
 * while the values represent details or an array/list of dependents affiliated
 * with each vendor. The structure of the values is determined by the application requirements.
 *
 * This variable is intended to facilitate operations that involve
 * tracking or accessing dependents for a specific vendor.
 */
const vendorDependants = {};

/**
 * Logs a message at the specified log level. Messages are logged when they meet the criteria
 * defined by the logging configuration or if explicitly forced.
 *
 * @param {string} level - The log level, such as "INFO", "WARN", or "ERROR".
 * @param {string} message - The message to log.
 * @param {boolean} [force=false] - Determines whether the message should be logged regardless
 *                                  of the configured logging constraints.
 * @return {void} Does not return a value.
 */
function log(level, message, force = false) {
  const colorMap = {
    ERROR: "\x1b[31m", // Red
    WARN: "\x1b[33m",  // Yellow
    INFO: "\x1b[32m",  // Green
    DEBUG: "\x1b[34m", // Blue
  };

  const reset = "\x1b[0m";

  const shouldLog = {
    ERROR: true,
    WARN: true,
    INFO: !ONLY_ERRORS || force,
    DEBUG: DEBUG || force,
  }[level];

  if (shouldLog) {
    const coloredLevel = `${colorMap[level] || ""}[${level}]${reset}`;
    console.log(`${coloredLevel} ${message}`);
  }
}

/**
 * Executes a shell command in the specified working directory.
 *
 * @param {string} command - The command to be executed.
 * @param {string} cwd - The current working directory where the command will run.
 * @param {boolean} [suppressLogs=false] - Optional flag to suppress logs. If true, command output will not be displayed in the console.
 * @return {void} This method does not return a value but throws an error if the command execution fails.
 */
function runCommand(command, cwd, suppressLogs = false) {
  try {
    log("DEBUG", `Running: ${command} in ${cwd}`);
    execSync(command, {
      cwd,
      stdio: suppressLogs ? ["ignore", "ignore", "inherit"] : "inherit", // Suppress logs if suppressLogs is true, otherwise inherit terminal
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
 * Creates a backup of the specified directory if it exists. The backup is stored in a temporary
 * directory under a "backups" folder with a unique timestamped name. Logs the backup operation
 * and updates a tracking list with the original and backup paths.
 *
 * @param {string} dirPath - The path of the directory to be backed up.
 * @return {string|null} The path of the created backup directory if the backup is successful,
 *                        or `null` if the specified directory does not exist.
 */
function backupDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    log("DEBUG", `No backup needed; directory does not exist: ${dirPath}`);
    return null;
  }

  const backupPath = path.join(tempDir, "backups", `backup_${path.basename(dirPath)}_${Date.now()}`);
  fs.cpSync(dirPath, backupPath, { recursive: true });
  backupDirs.push({ original: dirPath, backup: backupPath });
  log("DEBUG", `Backup created for ${dirPath} at ${backupPath}`);
  return backupPath;
}

/**
 * Performs a rollback operation by restoring directories from backup locations.
 * This function iterates over the defined `backupDirs`, restores backups to their original locations,
 * and removes temporary backup directories upon successful restoration.
 *
 * @return {void} This method does not return any value.
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
        log("DEBUG", `Restored backup from ${backup} to ${original}`);
      } catch (error) {
        log("ERROR", `Failed to restore backup for ${original}: ${error.message}`);
      }

      try {
        fs.rmSync(backup, { recursive: true, force: true });
        log("DEBUG", `Cleaned up temporary backup: ${backup}`);
      } catch (cleanupError) {
        log("WARN", `Failed to clean up temporary backup: ${backup} - ${cleanupError.message}`);
      }
    }
  }
  log("INFO", "Rollback process completed.");
}

/**
 * Unpacks a tarball file into a specified target directory.
 * Additionally, if debugging is enabled, creates a debug directory and unpacks the tarball into it as well.
 *
 * @param {string} tarballPath - The file path to the tarball that needs to be unpacked.
 * @param {string} target - The target directory where the contents of the tarball will be extracted.
 * @return {Promise<void>} - A promise that resolves when the unpacking is successfully completed.
 * @throws {Error} - Throws an error if the unpacking process encounters an issue.
 */
async function unpackTarball(tarballPath, target) {
  const baseDir = path.resolve();

  // Resolve the full target directory
  const resolvedTargetBaseDir = path.join(baseDir, target);
  const debugDir = path.join(path.resolve("debug_vendors"), target);

  // Ensure the directory structure exists
  log("DEBUG", `Ensuring directory exists: ${resolvedTargetBaseDir}`);
  fs.mkdirSync(resolvedTargetBaseDir, { recursive: true });

  // Perform the unpacking
  log("DEBUG", `Unpacking ${tarballPath} into ${resolvedTargetBaseDir}`);
  const cwd = path.dirname(tarballPath); // Ensure the working directory is correct

  try {
    runCommand(`tar -xzf ${tarballPath} --strip-components=1 -C ${resolvedTargetBaseDir}`, cwd);
  } catch (error) {
    log("ERROR", `Failed to unpack ${tarballPath} into ${resolvedTargetBaseDir}: ${error.message}`);
    throw error;
  }

  if (DEBUG) {
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      log("DEBUG", `Unpack ${tarballPath} at debug dir: ${debugDir}`);
      runCommand(`tar -xzf ${tarballPath} --strip-components=1 -C ${debugDir}`, cwd);
    } catch (error) {
      log("ERROR", `Failed to unpack ${tarballPath} into ${debugDir}: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Processes a list of vendors by performing dependency installations, builds, packaging,
 * and unpacking operations in two distinct phases.
 *
 * Phase 1: Installs the dependencies for each vendor if required.
 * Phase 2: Builds, packs, and unpacks vendor packages based on the specified configuration.
 *
 * @param {Array<Object>} vendors - An array of vendor objects to process.
 * Each vendor object should contain:
 *   - {string} name - The name of the vendor.
 *   - {string} path - The path to the vendor's files.
 *   - {Object} [install] - Optional installation details:
 *       - {boolean} required - Whether dependencies installation is required.
 *       - {string} [script] - The script to execute for installation (defaults to "yarn install").
 *   - {Object} [build] - Optional build details:
 *       - {boolean} required - Whether the build process is required.
 *       - {string} [script] - The script to execute for building (defaults to "yarn build").
 * @param {string} tempDir - The temporary directory path where intermediate files (e.g., tarballs) will be stored.
 * @param {Object} [dependenciesResolution={}] - Optional mapping of package names to a set of unpacking target paths.
 *        Keys are package names, and values are sets of filesystem paths for unpacking.
 *
 * @return {Promise<void>} Resolves when the vendor processing is complete.
 * Throws an error for any failures during processing.
 */
async function processVendors(vendors, tempDir, dependenciesResolution = {}) {
  log("INFO", "Starting vendor processing in two phases.");
  const tempTgzFolder = path.join(tempDir, "tgz");
  fs.mkdirSync(tempTgzFolder, { recursive: true });

  // Phase 1: Install all dependencies
  log("INFO", "Phase 1: Installing all vendor dependencies.");
  for (const vendor of vendors) {
    const { name, path: vendorPath, install } = vendor;

    if (install?.required) {
      log("INFO", `Installing dependencies for vendor: ${name}`);
      const absolutePath = path.resolve(vendorPath);

      // Ensure we suppress logs during installation
      try {
        if (install.cleanCache) {
          runCommand("yarn cache clean", absolutePath, true); // Suppress logs
        }
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
    const { name, path: vendorPath, build } = vendor;

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
      const packages = vendorTargets[vendor.name];

      for (const pkgName of packages) {
        let packageFolder = pkgName.split("/")[1];
        // just in case there is a difference between the package name and folder
        if (vendor.packageResolution && vendor.packageResolution[packageFolder]) {
          packageFolder = vendor.packageResolution[packageFolder];
        }
        const packagePath = path.join(packagesDir, packageFolder);
        const packageJsonPath = path.join(packagePath, "package.json");

        if (!fs.existsSync(packageJsonPath)) {
          log("WARN", `Skipping ${pkgName}: package.json not found`);
          continue;
        }

        const sanitizedName = pkgName.replace(/\//g, "-");
        const tarballName = `${sanitizedName}.tgz`;
        const tarballPath = path.join(tempTgzFolder, tarballName);

        log("INFO", `Packing ${pkgName} into ${tarballPath}`);
        runCommand(`yarn pack --out ${tarballPath}`, packagePath, true); // Suppress logs

        // Step 2.3: Unpack the tarball into each specified target
        const unpackTargets = dependenciesResolution[pkgName] || new Set();
        for (const target of unpackTargets) {
          try {
            backupDirectory(target);
            await unpackTarball(tarballPath, target);
          } catch (e) {
            log("ERROR", `Failed to unpack tarball for package ${pkgName} into target "${target}": ${e.message}`);
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
 * Normalizes the provided file path by removing specific suffix patterns.
 *
 * @param {string} fullPath - The full file path that needs to be normalized.
 * @return {string} The normalized file path with specific suffixes removed.
 */
function normalizePath(fullPath) {
  return fullPath.replace(/@(?:workspace|npm|virtual)$/, "");
}

/**
 * Analyzes the resolution paths of a given package within a specified working directory.
 * This method utilizes the Yarn package manager's `yarn why` command to trace dependencies and their locations.
 *
 * @param {string} packageName - The name of the package for which to analyze resolution paths.
 * @param {string} workingDir - The directory in which the analysis should be performed.
 * @return {string[]} An array of resolved paths for the specified package, or an empty array if no paths are found or an error occurs.
 */
function analyzePathResolution(packageName, workingDir) {
  try {
    const output = execSync(`yarn why ${packageName} --json`, {
      cwd: workingDir,
      encoding: "utf-8",
    });

    if (output === "") return [];

    const resolvedPaths = new Set();
    resolvedPaths.add(normalizePath(path.join("node_modules", packageName)));
    const lines = output.trim().split("\n");

    for (const line of lines) {
      const json = JSON.parse(line);

      const [nestedParent] = json.value.split(":");
      const nestedParentPath = normalizePath(path.join("node_modules", nestedParent));
      if (json.children) {
        for (const child of Object.values(json.children)) {
          if (child.locator) {
            const [dependency] = child.locator.split(":");
            const rawPath = path.join("node_modules", dependency);
            resolvedPaths.add(path.join(nestedParentPath, normalizePath(rawPath)));
          }
        }
      }
    }

    return Array.from(resolvedPaths);
  } catch (error) {
    log("ERROR", `Error running yarn why for ${packageName}: ${error.message}`);
    return [];
  }
}

/**
 * Parses the vendor dependencies from the given configuration and populates the vendorDependants object.
 *
 * @param {Object} config - The configuration object containing vendor information.
 * @param {Object[]} config.vendors - An array of vendor objects.
 * @param {string[]} [config.vendors[].dependencies] - An optional array of dependencies for each vendor.
 * @return {void} This function does not return a value.
 */
function parseVendorDependants(config) {
  const vendors = config["vendors"];
  vendors.forEach((vendor) => {
    if (vendor.dependencies) vendor.dependencies.forEach((dep) => {
      if (!vendorDependants[dep]) vendorDependants[dep] = new Set();
      vendorDependants[dep].add(vendor);
    });
  });
}

/**
 * Parses vendor target configurations and evaluates the packages for each vendor.
 *
 * @param {Object} config - The configuration object containing vendor information.
 * @param {Array} config.vendors - An array of vendor objects where each vendor contains the details of the vendor.
 * @param {string} config.vendors[].name - The name of the vendor (can include "@").
 * @param {string} config.vendors[].path - The path to the vendor directory.
 * @param {Object} [config.vendors[].pack] - An optional pack object to specify included packages.
 * @param {Array} [config.vendors[].pack.include] - An optional array of package names to include for this vendor.
 *
 * @return {void} This function does not return a value. Instead, it populates the `vendorTargets` object.
 */
function parseVendorTargets(config) {
  const vendors = config["vendors"];
  vendors.forEach((vendor) => {
    // get this vendor package
    const vendorName = vendor.name; // Strip "@"
    log("INFO", `Evaluating vendor targets: ${vendorName}`);
    const vendorBasePath = path.resolve(vendor.path);
    const packagesDir = path.join(vendorBasePath, "packages");
    // if we have pack.include, use that, otherwise read all from ${vendor.path}/packages
    const packages = vendor.pack?.include ? vendor.pack?.include : fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : [];
    const targets = new Set();
    // fill the target packages that we need to evaluate as dependency on other vendors
    for (const pkg of packages) {
      const packagePath = path.join(packagesDir, pkg);
      const packageJsonPath = path.join(packagePath, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        log("WARN", `Skipping ${pkg}: package.json not found`);
        continue;
      }
      const { name: pkgNameJson } = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      targets.add(pkgNameJson);
    }
    vendorTargets[vendorName] = targets;
  });
}

/**
 * Evaluates the dependencies of vendor packages based on the provided configuration
 * and analyzes their resolution paths.
 *
 * @param {Object} config - Configuration object containing vendor information and other dependencies.
 * @param {Array} config.vendors - List of vendor objects, each containing details like the vendor's name.
 * @return {Object} An object containing the evaluated dependencies for each target package,
 * mapping package names to their resolved paths.
 */
function evaluateDependencies(config) {
  const results = {};
  const vendors = config["vendors"];

  vendors.forEach((vendor) => {
    // get this vendor package
    const vendorName = vendor.name; // Strip "@"
    log("INFO", `Evaluating vendor dependencies against relations: ${vendorName}`);
    const targets = vendorTargets[vendorName] || new Set();
    const dependants = vendorDependants[vendor.name] || new Set();

    // Analyze each target package
    Array.from(targets).forEach((fullPackageName) => {
      const targets = new Set();

      // Analyze root resolution
      analyzePathResolution(fullPackageName, rootDir).forEach(p => targets.add(p));

      // Analyze vendor (dependants) resolution
      dependants.forEach(dep => {
        const dependantVendorBasePath = path.resolve(dep.path);
        analyzePathResolution(fullPackageName, dependantVendorBasePath).forEach(r => targets.add(path.join(dep.path, r)));
      });

      results[fullPackageName] = targets;
    });
  });

  return results;
}

/**
 * Main entry point for the application.
 * Handles configuration loading, validation, and execution of the package deployment workflow.
 * Processes vendors, evaluates their dependencies, and performs required operations
 * unless the application is in dry mode.
 *
 * @return {Promise<void>} A promise that resolves when the main process completes successfully, or rejects if an error occurs.
 */
async function main() {
  log("INFO", "Loading configuration...");
  if (!fs.existsSync(CONFIG_FILE)) {
    log("ERROR", `Configuration file not found: ${CONFIG_FILE}`);
    process.exit(1);
  }
  const config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (!config || !config.vendors) {
    log("ERROR", `Invalid configuration: ${CONFIG_FILE}`);
    process.exit(1);
  }

  const vendors = config.vendors;

  // ensure temporal tgz folder exists
  fs.mkdirSync(tempDir, { recursive: true });

  // parse vendor dependants (dependencies against vendors and root)
  parseVendorDependants(config);
  // parse vendor targets (which package of the vendor will be packed)
  parseVendorTargets(config);

  // Evaluate dependencies
  const dependenciesResolution = evaluateDependencies(config);
  if (DRY_MODE) {
    log("INFO", `Dependency Resolution:`, true);
    log("INFO", JSON.stringify(dependenciesResolution, (key, value) => {
      // custom replacer to print sets correctly
      if (value instanceof Set) {
        return [...value]; // Convert Set to Array
      }
      return value; // Use default behavior for other types
    }, 2), true);
    log("INFO", "DRY MODE - Earlier end due to --dry-mode flag.", true);
    process.exit(0);
  }

  try {
    await processVendors(vendors, tempDir, dependenciesResolution);
  } catch (error) {
    rollback();
    throw error; // bubble it
  } finally {
    // remove temporal directory if present
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.env.POSTINSTALL === "true" && process.env.DOCKER_BUILD === "true") {
  log("WARN", "Vendor builders are excluded during the Docker build process via a postinstall script.");
  process.exit(0);
}

// Entry point
main().then(r => {
  log("INFO", "All vendors processed successfully!");
  process.exit(0);
}).catch(e => {
  log("ERROR", `An error occurred: ${e.message}`);
  process.exit(1);
});
