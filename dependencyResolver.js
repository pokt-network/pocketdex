const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { execSync } = require("child_process");

/**
 * Load the YAML configuration file to parse vendor settings.
 */
function loadYamlConfig(yamlPath) {
  const content = fs.readFileSync(yamlPath, "utf-8");
  return yaml.load(content);
}

/**
 * Normalize node_modules paths to remove metadata like @workspace or @npm.
 */
function normalizePath(fullPath) {
  return fullPath.replace(/@(?:workspace|npm|virtual)$/, "");
}

/**
 * Run `yarn why` to analyze dependency resolution paths.
 */
function analyzePathResolution(packageName, workingDir) {
  try {
    const output = execSync(`yarn why ${packageName} --json`, {
      cwd: workingDir,
      encoding: "utf-8",
    });

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
    console.error(`Error running yarn why for ${packageName}: ${error.message}`);
    return [];
  }
}

/**
 * Resolve dependencies for each vendor and build the final JSON structure.
 */
function evaluateDependencies(config) {
  const rootDir = process.cwd();
  const results = {};

  // Iterate through each vendor
  config["vendor-packages"].forEach((vendor) => {
    const vendorName = vendor.name.replace("@", ""); // Strip "@"
    const vendorBasePath = path.resolve(vendor.path);
    const vendorDeps = vendor.dependencies || [];
    const targets = new Set((vendor.pack?.include ?? []).map((pkg) => `${vendor.name}/${pkg}`) || []);

    vendorDeps.forEach((dep) => {
      const depVendor = config["vendor-packages"].find((v) => v.name === dep);
      if (depVendor && depVendor.pack?.include) {
        depVendor.pack.include.forEach((pkg) =>
          targets.add(`${depVendor.name}/${pkg}`),
        );
      }
    });

    // Analyze each target package
    [...targets].forEach((fullPackageName) => {
      if (!results[fullPackageName]) {
        results[fullPackageName] = { root: [], vendor_dependencies: {} };
      }

      // Analyze root resolution
      if (results[fullPackageName].root.length === 0) {
        results[fullPackageName].root = analyzePathResolution(fullPackageName, rootDir);
      }

      // Skip self-evaluation
      if (fullPackageName.startsWith(vendor.name)) return;

      // Analyze vendor resolution
      const vendorResolutions = analyzePathResolution(fullPackageName, vendorBasePath);
      if (!results[fullPackageName].vendor_dependencies[vendorName]) {
        results[fullPackageName].vendor_dependencies[vendorName] = [];
      }
      results[fullPackageName].vendor_dependencies[vendorName].push(...vendorResolutions);
    });

  });

  return results;
}

/**
 * Main entry point to process YAML and log the dependencies JSON.
 */
function main() {
  const yamlPath = path.resolve(__dirname, "vendor-config.yaml");

  // Load YAML configuration
  const config = loadYamlConfig(yamlPath);

  // Evaluate dependencies
  const result = evaluateDependencies(config);

  // Log final JSON output to console
  console.log(JSON.stringify(result, null, 2));
}

main();
