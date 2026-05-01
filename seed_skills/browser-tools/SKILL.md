---
name: browser-tools
description: "Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, scrape dynamic content, take screenshots, execute JavaScript in a browser context, or extract page content. Triggers: web testing, frontend verification, visual regression, browser-based scraping, page interaction, Chromium automation, CDP debugging."
compatibility: Requires Chromium or Chrome installed (prefers CHROMIUM_PATH env var)
allowed-tools: Bash(browser-start:*) Bash(browser-nav:*) Bash(browser-screenshot:*) Bash(browser-content:*) Bash(browser-eval:*)
metadata:
  version: "1.0"
  author: canvas-studios
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to Chromium running on `:9222` with remote debugging enabled.

The launcher prefers `CHROMIUM_PATH` when it is set. If that is missing, it falls back to Puppeteer's bundled browser when present and then to common system Chromium/Chrome locations.

## Start Chromium

```bash
browser-start              # Container/no-display: headless. Local desktop: visible when possible.
browser-start --profile    # Copy your Chrome profile on local macOS runs
```

Launch Chromium with remote debugging on `:9222`.

- In Docker or other no-display environments, the browser starts headless with container-safe flags.
- On a local desktop, the browser stays visible when the environment supports it.
- `--profile` is only honored on local macOS runs with a visible browser and is ignored elsewhere so container startup keeps working.
- If the binary cannot be found, the error tells you which paths were tried.

## Navigate

```bash
browser-nav https://example.com
browser-nav https://example.com --new
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing the current tab.

## Evaluate JavaScript

```bash
browser-eval 'document.title'
browser-eval 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

## Screenshot

```bash
browser-screenshot
```

Capture current viewport and return temporary file path. Use to visually inspect page state or verify UI changes.

## Extract Page Content

```bash
browser-content https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction. Works on pages with JavaScript content (waits for page to load).

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution

---

## Efficiency Guide

### DOM Inspection Over Screenshots

**Don't** take screenshots to see page state. **Do** parse the DOM directly:

```javascript
// Get page structure
document.body.innerHTML.slice(0, 5000)

// Find interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map(e => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className
}))
```

### Complex Scripts in Single Calls

Wrap everything in an IIFE to run multi-statement code:

```javascript
(function() {
  // Multiple operations
  const data = document.querySelector('#target').textContent;
  const buttons = document.querySelectorAll('button');

  // Interactions
  buttons[0].click();

  // Return results
  return JSON.stringify({ data, buttonCount: buttons.length });
})()
```

### Batch Interactions

**Don't** make separate calls for each click. **Do** batch them:

```javascript
(function() {
  const actions = ["btn1", "btn2", "btn3"];
  actions.forEach(id => document.getElementById(id).click());
  return "Done";
})()
```

### Reading App/Game State

Extract structured state in one call:

```javascript
(function() {
  const state = {
    score: document.querySelector('.score')?.textContent,
    status: document.querySelector('.status')?.className,
    items: Array.from(document.querySelectorAll('.item')).map(el => ({
      text: el.textContent,
      active: el.classList.contains('active')
    }))
  };
  return JSON.stringify(state, null, 2);
})()
```

### Waiting for Updates

If DOM updates after actions, add a small delay:

```bash
sleep 0.5 && browser-eval '...'
```

### Investigate Before Interacting

Always start by understanding the page structure:

```javascript
(function() {
  return {
    title: document.title,
    forms: document.forms.length,
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    mainContent: document.body.innerHTML.slice(0, 3000)
  };
})()
```

Then target specific elements based on what you find.
