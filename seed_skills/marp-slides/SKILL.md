---
name: marp-slides
description: Create, edit, review, and export polished Marp Markdown slide decks in Canvas Notebook. Use when the user wants Markdown-based presentations, `.marp.md` or `.slides.md` files, fast version-controlled decks, Marp PDF/image/PPTX export, speaker notes, presentation outlines, or better looking slides that should stay close to plain text.
license: "MIT"
metadata:
  version: "1.1.0"
---

# Marp Slides

Create presentation decks as Marp Markdown files that Canvas Notebook can preview
and export. Use this skill when a Markdown-native deck is better than directly
authoring PowerPoint, Google Slides, or a custom HTML presentation.

## Output Contract

- Prefer a workspace file ending in `.marp.md` or `.slides.md`.
- Include `marp: true` in YAML frontmatter so Canvas enables the slide preview.
- Use `---` to separate slides after the frontmatter block.
- Keep the deck source readable and version-control friendly. Avoid dense raw
  HTML unless Markdown cannot express the layout.
- Use relative image paths for local workspace assets. Canvas inlines supported
  workspace images for preview and export.
- Return the final deck path and mention intended export format only if relevant.

## Canvas Workflow

1. Decide whether Marp is the right output:
   - Use Marp for text-first decks, technical talks, client narratives, reports,
     training, pitch drafts, and decks that should be easy to diff and revise.
   - Use the `pptx` skill when the user needs fully editable PowerPoint-native
     objects, corporate templates, or heavy manual editing in PowerPoint.
   - Use `frontend-slides` when the user needs a standalone animated web
     presentation with custom interaction.
2. Create or update a `.marp.md` / `.slides.md` file.
3. Start with a compact slide outline before writing full slide copy.
4. Define the visual system in frontmatter and one `<style>` block near the top.
5. Keep every slide within a 16:9 viewport. Split overloaded content.
6. If export is requested, use the Canvas UI export actions or the existing Marp
   export endpoints; do not hand-roll a converter.

## Required Deck Skeleton

Use this as the baseline and adapt the theme to the user's brand, audience, and
content.

```markdown
---
marp: true
theme: default
paginate: true
size: 16:9
title: "Presentation title"
description: "Short deck summary"
---

<style>
section {
  font-family: "Aptos", "Helvetica Neue", Arial, sans-serif;
  color: #111827;
  background: #f8fafc;
  padding: 56px;
}
section.lead {
  display: flex;
  flex-direction: column;
  justify-content: center;
}
h1 {
  font-size: 54px;
  line-height: 1.02;
}
h2 {
  font-size: 34px;
}
p,
li {
  font-size: 24px;
  line-height: 1.35;
}
strong {
  color: #2563eb;
}
footer {
  color: #64748b;
}
</style>

<!-- _class: lead -->
<!-- _paginate: false -->

# Presentation title

Short, specific promise for the audience.

---

## The point of this deck

- One clear idea per bullet.
- Keep bullets short.
- Split crowded slides.
```

## Slide Design Rules

- Title slide: one title, one subtitle, optional context line.
- Content slide: one idea, up to four bullets or two short paragraphs.
- Section divider: one section title and one sentence of orientation.
- Data slide: state the takeaway in the title; include units and source notes.
- Code slide: show only the lines that matter, usually no more than 12.
- Image slide: use the image as a real layout element, not decoration.
- Closing slide: summarize the decision, next step, or call to action.

Avoid generic decks. Pick a concrete visual direction: editorial report,
technical briefing, investor memo, product launch, workshop, or classroom
teaching. Match typography, spacing, color, and image treatment to that context.

## Marp Syntax Patterns

Use global directives in frontmatter:

```yaml
---
marp: true
theme: default
paginate: true
size: 16:9
---
```

Use local scoped directives for one slide:

```markdown
---

<!-- _class: lead -->
<!-- _paginate: false -->

# Section title
```

Use split image backgrounds for polished layouts:

```markdown
---

![bg right:42% cover](images/product-screenshot.png)

## What changed

- Faster workflow
- Clearer status
- Fewer manual steps
```

Use presenter notes only in HTML comments that are not directives:

```markdown
<!--
Presenter note: pause here and show the live example.
-->
```

## Quality Checks

- The file name or frontmatter triggers Marp preview in Canvas.
- Frontmatter is valid YAML and appears at the very top of the file.
- Slide separators are plain `---` lines.
- No slide depends on internet-only assets unless the user requested that.
- Text does not crowd the slide; split content rather than shrinking everything.
- Contrast is readable and repeated elements are consistent.
- Export limitations are clear: normal Marp PPTX export is visually faithful but
  not guaranteed to be fully editable as native PowerPoint objects.
