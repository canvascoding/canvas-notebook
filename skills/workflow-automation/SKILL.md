---
name: workflow-automation
description: Create and manage automated workflow jobs that run on a schedule. Use this skill when the user wants to automate tasks, create scheduled jobs, manage existing automations, or trigger workflows manually. Supports creating jobs with custom prompts/scripts that run at specified intervals (once, daily, weekly, or custom intervals).
license: MIT
---

# Workflow Automation

This skill allows you to create, manage, and trigger automated workflow jobs that execute on a schedule.

## When to Use

Use this skill when:
- The user wants to automate repetitive tasks
- Creating scheduled jobs that run prompts/scripts at specific times
- Managing existing automation jobs (list, update, pause, resume, delete)
- Manually triggering a scheduled job to run immediately
- Setting up recurring workflows (daily reports, weekly summaries, etc.)

## Available Operations

### 1. Create Automation Job
Creates a new scheduled automation job.

**Required Parameters:**
- `name`: A descriptive name for the job (max 120 characters)
- `prompt`: The script/prompt to execute when the job runs (max 12000 characters)
- `schedule`: When and how often the job should run

**Schedule Types:**
- **once**: Run once at a specific date and time
  - `date`: Date in YYYY-MM-DD format
  - `time`: Time in HH:MM format (24-hour)
  - `timeZone`: Timezone (default: UTC)
- **daily**: Run every day at a specific time
  - `time`: Time in HH:MM format
  - `timeZone`: Timezone (default: UTC)
- **weekly**: Run on specific days of the week
  - `days`: Array of days ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
  - `time`: Time in HH:MM format
  - `timeZone`: Timezone (default: UTC)
- **interval**: Run at regular intervals
  - `every`: Number (e.g., 30)
  - `unit`: "minutes", "hours", or "days"
  - `timeZone`: Timezone (default: UTC)

**Optional Parameters:**
- `preferredSkill`: Which skill to use for execution ("auto", "image_generation", "video_generation", "ad_localization", "qmd")
- `targetOutputPath`: Where to save job outputs (relative to workspace)
- `workspaceContextPaths`: Array of file paths to include as context
- `status`: "active" (default) or "paused"

### 2. List Automation Jobs
Returns all automation jobs with their current status and schedule information.

### 3. Update Automation Job
Modifies an existing job's parameters. Can be used to:
- Change the name, prompt, or schedule
- Pause or resume a job (status: "paused" or "active")
- Update the preferred skill or output path

**Required Parameter:**
- `jobId`: The ID of the job to update

### 4. Delete Automation Job
Permanently removes a job and all its run history.

**Required Parameter:**
- `jobId`: The ID of the job to delete

### 5. Trigger Automation Job
Manually executes a job immediately, regardless of its schedule.

**Required Parameter:**
- `jobId`: The ID of the job to trigger

## Examples

### Create a Daily Report Job
```
Create an automation job named "Daily Summary" that runs every day at 9:00 AM.
The prompt should generate a summary of yesterday's activities.
```

### Create a Weekly Backup Job
```
Create a weekly automation job that runs every Sunday at 2:00 AM to backup important files.
```

### Pause a Job
```
Pause the automation job with ID "job-xxx-xxx".
```

### Trigger a Job Now
```
Manually trigger the automation job "Daily Summary" to run immediately.
```

## Best Practices

1. **Job Names**: Use descriptive names that indicate the job's purpose
2. **Prompts**: Write clear, specific prompts that the automation can execute
3. **Scheduling**: Consider timezone differences when scheduling jobs
4. **Output Paths**: Specify target output paths to organize job results
5. **Status Management**: Pause jobs instead of deleting them if you need to temporarily stop them

## Output

Jobs create run artifacts in the workspace under:
- `automationen/{job-name}/runs/{timestamp}-{runId}/` - Technical run logs and metadata
- Configured `targetOutputPath` - Business results and deliverables

Each run produces:
- Execution logs
- Result files (if any)
- Metadata about the execution
