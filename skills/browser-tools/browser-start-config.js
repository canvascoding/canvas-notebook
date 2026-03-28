#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"];
const COMMON_BROWSER_PATHS = [
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

function hasDisplay(env = process.env, platform = process.platform) {
	if (platform === "darwin") {
		return true;
	}

	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function isContainerRuntime({
	env = process.env,
	existsSync = fs.existsSync,
} = {}) {
	if (env.CANVAS_RUNTIME_ENV === "docker") {
		return true;
	}

	if (env.CONTAINER?.toLowerCase() === "true") {
		return true;
	}

	return CONTAINER_MARKERS.some((marker) => existsSync(marker));
}

export function getRuntimeMode(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const displayAvailable = hasDisplay(env, platform);
	const container = isContainerRuntime(options);

	return {
		container,
		displayAvailable,
		headless: container || !displayAvailable,
	};
}

function safePuppeteerExecutablePath(getPuppeteerExecutablePath) {
	try {
		return getPuppeteerExecutablePath();
	} catch {
		return null;
	}
}

function resolveBundledPuppeteerExecutablePath() {
	const require = createRequire(import.meta.url);
	const puppeteer = require("puppeteer");
	return puppeteer.executablePath();
}

function findExecutableOnPath(execSyncImpl, env) {
	try {
		const result = execSyncImpl(
			"which chromium || which chromium-browser || which google-chrome || which google-chrome-stable",
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env },
		)
			.trim()
			.split("\n")
			.map((entry) => entry.trim())
			.find(Boolean);
		return result || null;
	} catch {
		return null;
	}
}

export function resolveChromiumExecutable({
	env = process.env,
	existsSync = fs.existsSync,
	getPuppeteerExecutablePath = resolveBundledPuppeteerExecutablePath,
	execSyncImpl = execSync,
} = {}) {
	const attemptedPaths = [];

	const configuredPath = env.CHROMIUM_PATH?.trim();
	if (configuredPath) {
		attemptedPaths.push(configuredPath);
		if (existsSync(configuredPath)) {
			return {
				executablePath: configuredPath,
				source: "env",
				attemptedPaths,
			};
		}
	}

	const puppeteerPath = safePuppeteerExecutablePath(getPuppeteerExecutablePath);
	if (puppeteerPath) {
		attemptedPaths.push(puppeteerPath);
		if (existsSync(puppeteerPath)) {
			return {
				executablePath: puppeteerPath,
				source: "puppeteer",
				attemptedPaths,
			};
		}
	}

	for (const candidate of COMMON_BROWSER_PATHS) {
		attemptedPaths.push(candidate);
		if (existsSync(candidate)) {
			return {
				executablePath: candidate,
				source: "system",
				attemptedPaths,
			};
		}
	}

	const whichPath = findExecutableOnPath(execSyncImpl, env);
	if (whichPath) {
		attemptedPaths.push(whichPath);
		if (existsSync(whichPath)) {
			return {
				executablePath: whichPath,
				source: "which",
				attemptedPaths,
			};
		}
	}

	const lookupSummary = unique(attemptedPaths).join(", ");
	throw new Error(
		`No Chromium/Chrome executable found. Checked: ${lookupSummary || "no candidate paths"}. ` +
			`Set CHROMIUM_PATH or install Chromium.`,
	);
}

export function buildBrowserLaunchSpec({
	env = process.env,
	platform = process.platform,
	existsSync = fs.existsSync,
	getPuppeteerExecutablePath,
	execSyncImpl = execSync,
	requestedProfile = false,
} = {}) {
	const runtime = getRuntimeMode({ env, platform, existsSync });
	const { executablePath, source, attemptedPaths } = resolveChromiumExecutable({
		env,
		existsSync,
		getPuppeteerExecutablePath,
		execSyncImpl,
	});
	const homeDir = env.HOME || "";
	const profileSupported = platform === "darwin" && !runtime.container && !runtime.headless;
	const profileEnabled = requestedProfile && profileSupported;
	const profileWarning =
		requestedProfile && !profileSupported
			? "Ignoring --profile because it is only supported on local macOS runs with a visible browser."
			: null;

	const args = [
		"--remote-debugging-port=9222",
		`--user-data-dir=${homeDir}/.cache/browser-tools`,
		"--no-first-run",
		"--no-default-browser-check",
	];

	if (runtime.headless) {
		args.push(
			"--headless=new",
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
		);
	}

	return {
		executablePath,
		executableSource: source,
		attemptedPaths,
		args,
		headless: runtime.headless,
		runtime,
		profileEnabled,
		profileWarning,
	};
}
