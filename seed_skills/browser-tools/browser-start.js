#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { buildBrowserLaunchSpec } from "./browser-start-config.js";

const useProfile = process.argv[2] === "--profile";

if (process.argv[2] && process.argv[2] !== "--profile") {
	console.log("Usage: browser-start.js [--profile]");
	console.log("\nOptions:");
	console.log("  --profile  Copy your default Chrome profile (cookies, logins)");
	process.exit(1);
}

const SCRAPING_DIR = `${process.env.HOME}/.cache/browser-tools`;

// Check if already running on :9222
try {
	const browser = await puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	});
	await browser.disconnect();
	console.log("✓ Browser already running on :9222");
	process.exit(0);
} catch {}

const launchSpec = buildBrowserLaunchSpec({ requestedProfile: useProfile });

if (launchSpec.profileWarning) {
	console.warn(`! ${launchSpec.profileWarning}`);
}

// Setup profile directory
execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });

// Remove SingletonLock to allow new instance
try {
	execSync(`rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`, { stdio: "ignore" });
} catch {}

if (launchSpec.profileEnabled) {
	console.log("Syncing profile...");
	execSync(
		`rsync -a --delete \
			--exclude='SingletonLock' \
			--exclude='SingletonSocket' \
			--exclude='SingletonCookie' \
			--exclude='*/Sessions/*' \
			--exclude='*/Current Session' \
			--exclude='*/Current Tabs' \
			--exclude='*/Last Session' \
			--exclude='*/Last Tabs' \
			"${process.env.HOME}/Library/Application Support/Google/Chrome/" "${SCRAPING_DIR}/"`,
		{ stdio: "pipe" },
	);
}

// Start Chromium with flags to force new instance
const child = spawn(launchSpec.executablePath, launchSpec.args, {
	detached: true,
	stdio: "ignore",
});
child.unref();

// Wait for Chrome to be ready
let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({
			browserURL: "http://localhost:9222",
			defaultViewport: null,
		});
		await browser.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error(
		`✗ Failed to connect to browser at :9222 (binary: ${launchSpec.executablePath}, ` +
			`source: ${launchSpec.executableSource}, headless: ${launchSpec.headless ? "yes" : "no"})`,
	);
	process.exit(1);
}

console.log(
	`✓ Browser started on :9222${launchSpec.profileEnabled ? " with your profile" : ""} ` +
		`(${launchSpec.headless ? "headless" : "visible"}, ${launchSpec.executableSource})`,
);
