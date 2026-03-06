#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PLAN_FILE = "docs/agent_implementation_plan.md";
const TODO_FILE = "docs/agent-implementation-todo.json";
const ACTIONABLE_SECTION_NUMBERS = new Set([5, 6, 7, 8, 9, 10, 11, 14]);

function parseLeadingSectionNumber(heading) {
  const match = heading.match(/^(\d+)(?:[.)]|\.\d+|\s|$)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isActionableSection(heading) {
  if (!heading) {
    return false;
  }

  if (/^Phase\s+\d+/i.test(heading)) {
    return true;
  }

  const sectionNumber = parseLeadingSectionNumber(heading);
  return sectionNumber !== null && ACTIONABLE_SECTION_NUMBERS.has(sectionNumber);
}

function categoryForHeading(heading) {
  if (!heading) {
    return "general";
  }

  if (/^Phase\s+\d+/i.test(heading) || /^10[.)\s]/.test(heading)) {
    return "implementation";
  }

  const sectionNumber = parseLeadingSectionNumber(heading);
  if (sectionNumber === 5) return "api";
  if (sectionNumber === 6) return "ui";
  if (sectionNumber === 7) return "bootstrap";
  if (sectionNumber === 8) return "migration";
  if (sectionNumber === 9) return "security";
  if (sectionNumber === 11) return "quality";
  if (sectionNumber === 14) return "acceptance";
  return "general";
}

function loadExistingStatusMap(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return new Map();
  }

  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
    const statusMap = new Map();

    for (const task of tasks) {
      if (!task || typeof task !== "object") {
        continue;
      }

      const section = typeof task.section === "string" ? task.section : "";
      const title = typeof task.title === "string" ? task.title : "";
      const status = typeof task.status === "string" ? task.status : "pending";
      const key = `${section}::${title}`;
      statusMap.set(key, status);
    }

    return statusMap;
  } catch {
    return new Map();
  }
}

function extractTasks(planText, existingStatusMap) {
  const lines = planText.split(/\r?\n/);
  const tasks = [];
  let h2 = "";
  let h3 = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();

      if (level === 2) {
        h2 = headingText;
        h3 = "";
      } else if (level === 3) {
        h3 = headingText;
      }
      continue;
    }

    if (!isActionableSection(h2)) {
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (!listMatch) {
      continue;
    }

    const depth = Math.floor(listMatch[1].length / 2);
    let title = listMatch[3].trim();
    if (!title) {
      continue;
    }

    const checkboxMatch = title.match(/^\[([ xX])\]\s+(.+)$/);
    let status = "pending";
    if (checkboxMatch) {
      status = checkboxMatch[1].toLowerCase() === "x" ? "done" : "pending";
      title = checkboxMatch[2].trim();
    }

    const section = h3 ? `${h2} / ${h3}` : h2;
    const preservedStatus = existingStatusMap.get(`${section}::${title}`);
    if (!checkboxMatch && preservedStatus) {
      status = preservedStatus;
    }

    tasks.push({
      title,
      status,
      section,
      category: categoryForHeading(h2),
      source: {
        file: PLAN_FILE,
        line: index + 1
      },
      depth
    });
  }

  return tasks.map((task, index) => ({
    id: `agent-${String(index + 1).padStart(3, "0")}`,
    order: index + 1,
    ...task
  }));
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function syncOnce(rootDir) {
  const planPath = path.resolve(rootDir, PLAN_FILE);
  const outputPath = path.resolve(rootDir, TODO_FILE);

  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }

  const existingStatusMap = loadExistingStatusMap(outputPath);
  const planText = fs.readFileSync(planPath, "utf8");
  const tasks = extractTasks(planText, existingStatusMap);
  const nowIso = new Date().toISOString();

  const output = {
    title: "Agent Implementation Todo",
    sourceFile: PLAN_FILE,
    generatedAt: nowIso,
    taskCount: tasks.length,
    tasks
  };

  writeJsonAtomic(outputPath, output);
  return { outputPath, taskCount: tasks.length };
}

function runWatchMode(rootDir) {
  const planPath = path.resolve(rootDir, PLAN_FILE);

  let timeout = null;
  const scheduleSync = () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      try {
        const result = syncOnce(rootDir);
        // eslint-disable-next-line no-console
        console.log(`[agent-todos] synced ${result.taskCount} tasks -> ${result.outputPath}`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[agent-todos] sync failed: ${error.message}`);
      }
    }, 150);
  };

  scheduleSync();
  fs.watch(planPath, { persistent: true }, scheduleSync);
  // eslint-disable-next-line no-console
  console.log(`[agent-todos] watching ${planPath}`);
}

function main() {
  const watchMode = process.argv.includes("--watch");
  const rootDir = process.cwd();

  try {
    if (watchMode) {
      runWatchMode(rootDir);
      return;
    }

    const result = syncOnce(rootDir);
    // eslint-disable-next-line no-console
    console.log(`[agent-todos] synced ${result.taskCount} tasks -> ${result.outputPath}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[agent-todos] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
