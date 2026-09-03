# Origami Agent Icon System

## Purpose

Bradley remains the unique main character of Canvas Notebook. Secondary agents use a related family of compact origami companions so that they feel personal without competing with Bradley's identity.

The runtime keeps the existing `iconId` values. Only their visual representation changes, which preserves stored agent profiles, API payloads, templates, and migrations.

## Visual direction

- **Family resemblance:** faceted paper silhouettes, one visible folded corner, dark ink details, and transparent backgrounds.
- **Bradley hierarchy:** Bradley keeps the blue notebook body, asymmetric arm fold, and animated working state. Secondary glyphs are smaller, front-facing companions with role badges.
- **Small-size clarity:** each role has one dominant silhouette and one bold badge. Fine lines, text, gradients, filters, and shadows are avoided.
- **Colour:** paper pigments distinguish roles, while the navy ink and white badge marks remain consistent. Meaning never depends on colour alone.
- **Geometry:** every master uses a `0 0 64 64` viewBox and stays inside a 4-unit safe area.
- **Accessibility:** runtime images are decorative because adjacent UI text names the agent or role. Standalone masters include a title and description.

## Role matrix

| Existing `iconId` | Product label | Origami motif | Paper colour |
| --- | --- | --- | --- |
| `bot` | Agent | neutral companion with a simple identity dot | Slate blue |
| `sparkles` | Creative | companion with a four-point spark | Coral |
| `search` | Research | companion with a magnifying lens | Teal |
| `code` | Code | companion with code chevrons | Indigo |
| `palette` | Studio | companion with a three-dot palette | Rose |
| `briefcase` | Business | companion with a compact case | Ochre |
| `calendar` | Automation | companion with a calendar grid | Green |
| `messages` | Support | companion with a speech bubble | Cyan |
| `brain` | Strategy | companion with a branching map | Violet |
| `wrench` | Tools | companion with a bold tool mark | Graphite |
| `rocket` | Launch | upward companion with a launch arrow | Orange |
| `shield` | Security | companion with a shield inset | Forest |

## Deliverables

```text
docs/architecture/canvas-notebook/assets/agent-origami-icons/
  README.md
  glyphs/                 Editable SVG masters
  previews/               Self-contained comparison artwork
public/images/agents/origami/
  <iconId>.svg             Runtime copies
```

The comparison board must embed the artwork instead of referencing sibling SVG files. This keeps every glyph visible when the board is opened on its own or rendered by repository tooling.

## Runtime contract

- `AGENT_ICON_IDS` remains unchanged.
- `AgentIcon` retains `iconId` and `className` props.
- Unknown values continue to normalize to `bot`.
- `AgentAvatar` and its layout contract remain unchanged.
- `AgentIdentityIcon` continues to render Bradley for the main-agent identifier.
- Delegation toolset icons are not agent identities and remain Lucide-based.

## Acceptance checks

- All twelve glyphs are recognizable at 16, 20, 24, 32, and 64 pixels.
- Light and dark surfaces preserve silhouette and badge contrast.
- The comparison board contains no external image references.
- Every catalog ID resolves to an existing SVG and unknown IDs still use `bot`.
- Settings, chat, history, delegation, memory, browser settings, and automations keep their current spacing.
- Reduced-motion behaviour for Bradley is unaffected.

## Implementation sequence

1. Create and review four representative directions: Agent, Research, Code, and Studio.
2. Lock the shared body, fold, ink, badge size, and colour contrast.
3. Apply the system to all twelve existing IDs.
4. Replace only the central `AgentIcon` rendering implementation.
5. Run source contracts, asset validation, UI checks, lint, and the production build.
