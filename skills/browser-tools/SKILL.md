---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, scrape dynamic content, or when user interaction with a visible browser is required. Chromium is included via puppeteer.
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to Chromium running on `:9222` with remote debugging enabled.

Chromium is bundled via the `puppeteer` npm package and is automatically available — no separate installation needed.

## Start Chromium

```bash
skill browser-start              # Fresh profile (headless, works in Docker)
skill browser-start --profile    # Copy user's Chrome profile (macOS only)
```

Launch Chromium with remote debugging on `:9222`. Use `--profile` to preserve the user's authentication state (only works on macOS with Chrome installed).

## Navigate

```bash
skill browser-nav https://example.com
skill browser-nav https://example.com --new
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing the current tab.

## Evaluate JavaScript

```bash
skill browser-eval 'document.title'
skill browser-eval 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

## Screenshot

```bash
skill browser-screenshot
```

Capture current viewport and return temporary file path. Use to visually inspect page state or verify UI changes.

## Extract Page Content

```bash
skill browser-content https://example.com
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
sleep 0.5 && skill browser-eval '...'
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
