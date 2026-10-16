# Complete Canvas plugin and connection declarations

Use the current server schemas returned by tool discovery and the complete draft validation report. This example documents Canvas's current canonical manifest and Workflow V1; it does not replace server validation or supply an actual connected provider.

## Minimal useful plugin

Write `.canvas-plugin/plugin.json`, at least one complete child `skills/<name>/SKILL.md`, and the actual purpose SVG at `assets/logo.svg`. Add useful references/scripts only as needed. A plugin copied from other sources must contain their complete materialized files before publication; do not leave seed-name references in a new immutable package.

```json
{
  "schemaVersion": 1,
  "name": "account-brief",
  "version": "1.0.0",
  "description": "Prepare source-backed company briefs from CRM and research.",
  "skills": "./skills",
  "interface": {
    "displayName": "Account Brief",
    "shortDescription": "Turn company facts into a source-backed brief",
    "brandColor": "#17614B",
    "logo": "./assets/logo.svg",
    "defaultPrompt": ["Prepare a source-backed brief for this company."]
  },
  "connectors": {
    "composio": [{
      "toolkit": "hubspot",
      "label": "HubSpot",
      "required": true,
      "reason": "Read the selected company's authorized CRM facts."
    }],
    "mcp": [{
      "name": "company-research",
      "label": "Company Research",
      "required": true,
      "reason": "Read research from the explicitly selected custom MCP."
    }]
  },
  "workflow": {
    "version": 1,
    "integrationCapabilities": [
      {
        "id": "crm",
        "application": "hubspot",
        "required": true,
        "alternatives": [{"source": "composio", "toolkit": "hubspot"}],
        "skillRefs": ["account-brief"]
      },
      {
        "id": "research",
        "application": "research",
        "required": true,
        "alternatives": [{"source": "mcp", "connector": "company-research"}],
        "skillRefs": ["account-brief"]
      }
    ]
  }
}
```

The example needs both CRM and research. Multiple required capabilities are AND; verified alternatives within one capability are OR. Avoid a separate required legacy connector that accidentally removes an intended alternative. An optional recommendation does not establish readiness.

Choose toolkit slugs from the actual Composio catalog and MCP connector identities from the package. `requiredTools`, when supplied, contains verified actual tool names from discovery/description. Do not invent a tool name from a display label. No `requiredTools` list is needed before that evidence exists; report tools as unverified.

## Skill content and precise runtime routing

Each skill has its own version independent of the plugin. The child frontmatter contains its name, useful description and `metadata.version: "1.0.0"`. Optional `agents/canvas.yaml` may supply UI metadata and a Workflow V1 block. Plugin children use the parent's MCP declarations; only a standalone skill may carry `workflow.mcpConnectors`.

Write the real behavior into the skill. For the account-brief example:

- Extract the requested company and missing inputs from the request.
- Use the current context's mapping for requirement `crm` and its selected account. Search only that provider for the needed company-read tools, describe the returned exact tool to obtain the current schema, then call with schema-valid arguments.
- Do the same for requirement `research`, using its selected custom MCP provider.
- Keep source facts, dates and missing evidence explicit in the brief. A missing binding or unavailable provider leaves that section incomplete; no fabricated data or account switching.
- If the plugin includes an authorized document-writing skill, load its exact supplied skill path before using it.

These are portable requirement names, not concrete `providerRef`, profile, account or tool/schema receipts. The runtime supplies exact mappings after setup. Do not bake private references into the skill or broaden the selected agent's provider/tool limits.

## Optional setup templates and Email

An existing custom MCP can be selected later without a config template. If the user actually supplies a portable server configuration, store it in a declared local `connectors/*.json` and set the connector's `configPath`. Use supported public server URLs or portable command/args and ENV placeholders. A template is a setup suggestion; it neither hosts a server nor creates a live definition automatically. Do not invent an example endpoint and report it as working.

Declare secret key names, not values. Tokens, absolute local paths, held runtime receipts and personal account/profile/connection/definition IDs never belong in the package. The shared Secrets service stores values. Keep provider logos separate from the plugin purpose image.

Canvas Email uses the existing `connectors.email` mailbox recommendations and Email tools. Supported provider hints are `gmail` and `imap-smtp`; Workflow V1 alternatives remain MCP or Composio. Do not invent `source: "email"`, a new credential file or a second provider registry.

For edits, retain source/license/author facts and raise changed package/skill versions appropriately. A successful schema check, saved organization version, use grant, activation, completed account setup and a successful tool call are separate results.
