# Origami Agent Icon System

## Purpose

Bradley remains the unique main character of Canvas Notebook. Secondary agents use a related family of compact origami companions so that they feel personal without competing with Bradley's identity.

The runtime keeps the existing `iconId` values. Only their visual representation changes, which preserves stored agent profiles, API payloads, templates, and migrations.

## Visual direction

- **Family resemblance:** faceted paper silhouettes, one visible folded corner, dark ink details, and transparent backgrounds.
- **Bradley hierarchy:** Bradley keeps the blue notebook body, asymmetric arm fold, and animated working state. Secondary glyphs are smaller companions whose poses and held objects communicate their roles.
- **Individual character:** every companion varies its body proportions, fold direction, arms, two-foot stance, and working pose instead of reusing one coloured body.
- **Small-size clarity:** each role has one dominant silhouette and one bold object or gesture. Fine lines, text, gradients, filters, and shadows are avoided.
- **Colour:** paper pigments distinguish roles, while the navy ink and white badge marks remain consistent. Meaning never depends on colour alone.
- **Geometry:** every master uses a `0 0 64 64` viewBox and keeps every folded-paper edge inside the artboard.
- **Accessibility:** runtime images are decorative because adjacent UI text names the agent or role. Standalone masters include a title and description.

## Role matrix

| Existing `iconId` | Product label | Origami motif | Paper colour |
| --- | --- | --- | --- |
| `bot` | Agent | upright companion waving one folded hand | Slate blue |
| `sparkles` | Creative | asymmetric companion reaching toward a spark | Coral |
| `search` | Research | forward-leaning companion holding a magnifying lens | Teal |
| `code` | Code | wide companion bracing a code panel with both hands | Indigo |
| `palette` | Studio | painter holding a palette and raised brush | Rose |
| `briefcase` | Business | upright companion carrying a case with both hands | Ochre |
| `calendar` | Automation | boxy companion presenting a calendar | Green |
| `messages` | Support | attentive companion offering a speech bubble | Cyan |
| `brain` | Strategy | broad thinking companion with hand at temple | Violet |
| `wrench` | Tools | compact companion raising a wrench | Graphite |
| `rocket` | Launch | tall companion reaching upward in a launch pose | Orange |
| `shield` | Security | broad companion standing behind a shield | Forest |
| `email` | Email | companion holding a large envelope with both hands | Marine blue |

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

- Existing `AGENT_ICON_IDS` values remain unchanged; `email` is added as a backward-compatible picker option.
- `AgentIcon` retains `iconId` and `className` props.
- Unknown values continue to normalize to `bot`.
- `AgentAvatar` and its layout contract remain unchanged.
- `AgentIdentityIcon` continues to render Bradley for the main-agent identifier.
- Delegation toolset icons are not agent identities and remain Lucide-based.

## Acceptance checks

- All thirteen glyphs are recognizable at 12, 16, 20, 24, 32, and 64 pixels.
- Light and dark surfaces preserve silhouette and badge contrast.
- The comparison board contains no external image references.
- Every catalog ID resolves to an existing SVG and unknown IDs still use `bot`.
- Settings, chat, history, delegation, memory, browser settings, and automations keep their current spacing.
- Reduced-motion behaviour for Bradley is unaffected.

## Implementation sequence

1. Create and review four representative directions: Agent, Research, Code, and Studio.
2. Lock the shared fold language, ink, object scale, stance, and colour contrast while preserving individual silhouettes.
3. Apply the system to all twelve existing IDs and add the Email role.
4. Replace only the central `AgentIcon` rendering implementation.
5. Run source contracts, asset validation, UI checks, lint, and the production build.
