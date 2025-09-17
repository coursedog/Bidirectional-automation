const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const isWindows = os.platform() === "win32";
const isMac = os.platform() === "darwin";
const isLinux = os.platform() === "linux";

console.log("🚀 Bi-directional Tests Automation Tool - Dependency Installer");
console.log("=" .repeat(60));

// Check if package.json exists
if (!fs.existsSync("package.json")) {
  console.error("❌ package.json not found. Please run this script from the project root directory.");
  process.exit(1);
}

// Check Node.js version
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
if (majorVersion < 18) {
  console.error(`❌ Node.js version ${nodeVersion} detected. This tool requires Node.js 18.0 or higher.`);
  console.error("Please update Node.js and try again.");
  process.exit(1);
}

console.log(`✅ Node.js ${nodeVersion} detected`);

// Install npm dependencies
console.log("\n📦 Installing npm dependencies...");
exec("npm install", (error, stdout, stderr) => {
  if (error) {
    console.error(`❌ Error installing npm dependencies: ${error.message}`);
    return;
  }
  if (stderr) console.error(stderr);
  if (stdout) console.log(stdout);
  
  console.log("✅ npm dependencies installed successfully");
  
  // Install Playwright browsers
  console.log("\n🌐 Installing Playwright browsers...");
  exec("npx playwright install", (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Error installing Playwright browsers: ${error.message}`);
      return;
    }
    if (stderr) console.error(stderr);
    if (stdout) console.log(stdout);
    
    console.log("✅ Playwright browsers installed successfully");
    
    // Set PowerShell execution policy on Windows
    if (isWindows) {
      console.log("\n⚙️ Setting PowerShell execution policy...");
      exec("powershell -Command \"Set-ExecutionPolicy -ExecutionPolicy Unrestricted -Scope CurrentUser -Force\"", (error, stdout, stderr) => {
        if (error) {
          console.warn(`⚠️ Warning: Could not set PowerShell execution policy: ${error.message}`);
          console.warn("You may need to run PowerShell as Administrator and set it manually.");
        } else {
          console.log("✅ PowerShell execution policy set successfully");
        }
        
        console.log("\n🎉 Installation completed successfully!");
        console.log("\nNext steps:");
        console.log("1. Run 'node index.js' or 'npm start' to begin");
        console.log("2. Follow the prompts to configure your test");
        console.log("3. Check the README.txt file for detailed instructions");
      });
    } else {
      console.log("\n🎉 Installation completed successfully!");
      console.log("\nNext steps:");
      console.log("1. Run 'node index.js' or 'npm start' to begin");
      console.log("2. Follow the prompts to configure your test");
      console.log("3. Check the README.txt file for detailed instructions");
    }
  });
}); 