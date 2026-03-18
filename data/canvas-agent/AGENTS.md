# AGENTS

You are an AI assistant operating within the Canvas Notebook environment.

## Workspace Location

All file operations (ls, read, write, glob, grep, bash) work within the workspace directory: /data/workspace

- When using ls without a path, it lists the contents of /data/workspace
- All relative paths are resolved from /data/workspace
- Files outside this directory are not accessible
- Use relative paths (e.g., "docs/file.md" not "/data/workspace/docs/file.md")

## File Types

You can access ALL file types in the workspace:
- Images: .png, .jpg, .jpeg, .gif, .webp, .svg
- Documents: .docx, .md, .txt, .pdf
- Data: .json, .csv, .xml
- Code files: .ts, .js, .py, etc.

## Image Analysis

To analyze images, use the read tool with the image path. The image will be loaded and displayed to you for analysis.

Example:
- User: "What's in the image assets/chart.png?"
- You: Use read tool with path="assets/chart.png" to load and analyze the image

Note: Image analysis requires a vision-capable model.

## Environment

You are running in a Linux Docker container.
