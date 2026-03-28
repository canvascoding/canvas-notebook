import assert from "node:assert/strict";

import {
	buildBrowserLaunchSpec,
	resolveChromiumExecutable,
} from "../skills/browser-tools/browser-start-config.js";

function makeExistsSync(existingPaths) {
	const existing = new Set(existingPaths);
	return (candidate) => existing.has(candidate);
}

function testEnvOverrideWins() {
	const result = resolveChromiumExecutable({
		env: { CHROMIUM_PATH: "/custom/chromium" },
		existsSync: makeExistsSync(["/custom/chromium"]),
		getPuppeteerExecutablePath: () => "/bundled/chrome",
		execSyncImpl: () => "",
	});

	assert.equal(result.executablePath, "/custom/chromium");
	assert.equal(result.source, "env");
}

function testPuppeteerFallbackWorks() {
	const result = resolveChromiumExecutable({
		env: {},
		existsSync: makeExistsSync(["/bundled/chrome"]),
		getPuppeteerExecutablePath: () => "/bundled/chrome",
		execSyncImpl: () => "",
	});

	assert.equal(result.executablePath, "/bundled/chrome");
	assert.equal(result.source, "puppeteer");
}

function testSystemFallbackWorks() {
	const result = resolveChromiumExecutable({
		env: {},
		existsSync: makeExistsSync(["/usr/bin/chromium"]),
		getPuppeteerExecutablePath: () => {
			throw new Error("missing");
		},
		execSyncImpl: () => "",
	});

	assert.equal(result.executablePath, "/usr/bin/chromium");
	assert.equal(result.source, "system");
}

function testErrorListsAttemptedPaths() {
	assert.throws(
		() =>
			resolveChromiumExecutable({
				env: { CHROMIUM_PATH: "/missing/custom" },
				existsSync: makeExistsSync([]),
				getPuppeteerExecutablePath: () => {
					throw new Error("missing");
				},
				execSyncImpl: () => "",
			}),
		(error) =>
			error instanceof Error &&
			error.message.includes("/missing/custom") &&
			error.message.includes("/usr/bin/chromium"),
	);
}

function testContainerLaunchFlags() {
	const spec = buildBrowserLaunchSpec({
		env: {
			CANVAS_RUNTIME_ENV: "docker",
			CHROMIUM_PATH: "/usr/bin/chromium",
			HOME: "/home/node",
		},
		platform: "linux",
		existsSync: makeExistsSync(["/usr/bin/chromium"]),
		getPuppeteerExecutablePath: () => {
			throw new Error("unused");
		},
		execSyncImpl: () => "",
		requestedProfile: true,
	});

	assert.equal(spec.headless, true);
	assert.equal(spec.profileEnabled, false);
	assert.match(spec.profileWarning ?? "", /Ignoring --profile/);
	assert.ok(spec.args.includes("--headless=new"));
	assert.ok(spec.args.includes("--no-sandbox"));
	assert.ok(spec.args.includes("--disable-dev-shm-usage"));
}

function testDesktopVisibleLaunchAllowsProfile() {
	const spec = buildBrowserLaunchSpec({
		env: {
			CHROMIUM_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			HOME: "/Users/tester",
		},
		platform: "darwin",
		existsSync: makeExistsSync([
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		]),
		getPuppeteerExecutablePath: () => {
			throw new Error("unused");
		},
		execSyncImpl: () => "",
		requestedProfile: true,
	});

	assert.equal(spec.headless, false);
	assert.equal(spec.profileEnabled, true);
	assert.equal(spec.profileWarning, null);
	assert.ok(!spec.args.includes("--headless=new"));
}

testEnvOverrideWins();
testPuppeteerFallbackWorks();
testSystemFallbackWorks();
testErrorListsAttemptedPaths();
testContainerLaunchFlags();
testDesktopVisibleLaunchAllowsProfile();

console.log("browser-start-test: ok");
