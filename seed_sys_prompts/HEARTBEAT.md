# Heartbeat Instructions

This file defines what the agent does on each heartbeat trigger.
The heartbeat runs automatically on a configured schedule and sends results directly to the user via Telegram.

## How to Configure

- **Schedule**: Configured in Settings → Channels → Telegram → Heartbeat
- **Instructions**: Edit this file directly or ask the agent to update it

## Task

Describe here what the agent should do on each heartbeat. Examples:

- Check recent workspace changes and summarize them
- Review open tasks and provide a status update
- Monitor specific files or directories for changes
- Generate a daily digest of important events

The agent will read this file and execute whatever instructions are defined here.
You can edit this file directly or ask the agent to update it.

## Format

Use clear, actionable instructions. The agent will follow these instructions step by step
and communicate the results directly in the Telegram chat.