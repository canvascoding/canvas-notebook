#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PLAN_FILE = "docs/pi-first-migration-plan.md";
const TODO_FILE = "docs/pi-first-implementation-todo.json";

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function validatePlanFile(planPath) {
  const plan = readText(planPath);
  if (!plan.trim()) {
    throw new Error(`Plan file is empty: ${planPath}`);
  }
  if (!plan.includes("PI-first")) {
    throw new Error(`Plan file does not appear to be PI-first plan: ${planPath}`);
  }
}

function validateTodoFile(todoPath) {
  let parsed;
  try {
    parsed = JSON.parse(readText(todoPath));
  } catch (error) {
    throw new Error(`Failed to parse todo JSON (${todoPath}): ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Todo payload must be an object: ${todoPath}`);
  }

  if (!Array.isArray(parsed.tasks)) {
    throw new Error(`Todo payload must contain a tasks array: ${todoPath}`);
  }

  const seenIds = new Set();
  for (const task of parsed.tasks) {
    if (!task || typeof task !== "object") {
      throw new Error("Todo tasks must be objects.");
    }

    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("Every todo task must have a non-empty string id.");
    }

    if (seenIds.has(task.id)) {
      throw new Error(`Duplicate task id detected: ${task.id}`);
    }
    seenIds.add(task.id);

    if (typeof task.order !== "number") {
      throw new Error(`Task ${task.id} must have a numeric order field.`);
    }

    if (typeof task.status !== "string") {
      throw new Error(`Task ${task.id} must have a string status field.`);
    }
  }
}

function validateOnce(rootDir) {
  const planPath = path.resolve(rootDir, PLAN_FILE);
  const todoPath = path.resolve(rootDir, TODO_FILE);

  ensureFileExists(planPath, "Plan");
  ensureFileExists(todoPath, "Todo");
  validatePlanFile(planPath);
  validateTodoFile(todoPath);

  return { planPath, todoPath };
}

function runWatchMode(rootDir) {
  const planPath = path.resolve(rootDir, PLAN_FILE);
  const todoPath = path.resolve(rootDir, TODO_FILE);

  let timeout = null;
  const scheduleValidation = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      try {
        const result = validateOnce(rootDir);
        // eslint-disable-next-line no-console
        console.log(`[agent-todos] validated ${result.planPath} and ${result.todoPath}`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[agent-todos] validation failed: ${error.message}`);
      }
    }, 150);
  };

  scheduleValidation();
  fs.watch(planPath, { persistent: true }, scheduleValidation);
  fs.watch(todoPath, { persistent: true }, scheduleValidation);

  // eslint-disable-next-line no-console
  console.log(`[agent-todos] watching ${planPath} and ${todoPath}`);
}

function main() {
  const watchMode = process.argv.includes("--watch");
  const rootDir = process.cwd();

  try {
    if (watchMode) {
      runWatchMode(rootDir);
      return;
    }

    const result = validateOnce(rootDir);
    // eslint-disable-next-line no-console
    console.log(`[agent-todos] validated ${result.planPath} and ${result.todoPath}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[agent-todos] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
