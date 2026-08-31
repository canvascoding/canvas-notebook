#!/usr/bin/env python3
"""Validate an Agent Skills package against the public format specification."""

import re
import sys
import unicodedata
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

ALLOWED_PROPERTIES = {
    'name',
    'description',
    'license',
    'allowed-tools',
    'metadata',
    'compatibility',
}

def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    if yaml is None:
        return False, "PyYAML is required. Install it with: python -m pip install PyYAML"

    # Check SKILL.md exists
    skill_md = skill_path / 'SKILL.md'
    if not skill_md.exists():
        return False, "SKILL.md not found"

    # Read and validate frontmatter
    content = skill_md.read_text(encoding='utf-8')
    if not content.startswith('---'):
        return False, "No YAML frontmatter found"

    # Extract frontmatter
    match = re.match(r'^---\r?\n(.*?)\r?\n---', content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    frontmatter_text = match.group(1)

    # Parse YAML frontmatter
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
        if not isinstance(frontmatter, dict):
            return False, "Frontmatter must be a YAML dictionary"
    except yaml.YAMLError as e:
        return False, f"Invalid YAML in frontmatter: {e}"

    # Check for unexpected properties (excluding nested keys under metadata)
    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed properties are: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    # Check required fields
    if 'name' not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if 'description' not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    # Extract name for validation
    name = frontmatter.get('name', '')
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = unicodedata.normalize('NFKC', name.strip())
    if not name:
        return False, "Name must be a non-empty string"
    if len(name) > 64:
        return False, f"Name is too long ({len(name)} characters). Maximum is 64 characters."
    if name != name.lower():
        return False, f"Name '{name}' must be lowercase"
    if name.startswith('-') or name.endswith('-') or '--' in name:
        return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
    if not all(character.isalnum() or character == '-' for character in name):
        return False, f"Name '{name}' may contain only Unicode letters, digits, and hyphens"
    directory_name = unicodedata.normalize('NFKC', skill_path.name)
    if directory_name != name:
        return False, f"Directory name '{skill_path.name}' must match skill name '{name}'"

    # Extract and validate description
    description = frontmatter.get('description', '')
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    if not description.strip():
        return False, "Description must be a non-empty string"
    if len(description) > 1024:
        return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."

    # Validate compatibility field if present (optional)
    if 'compatibility' in frontmatter:
        compatibility = frontmatter['compatibility']
        if not isinstance(compatibility, str):
            return False, f"Compatibility must be a string, got {type(compatibility).__name__}"
        if not compatibility.strip():
            return False, "Compatibility must be non-empty when provided"
        if len(compatibility) > 500:
            return False, f"Compatibility is too long ({len(compatibility)} characters). Maximum is 500 characters."

    for field in ('license', 'allowed-tools'):
        if field in frontmatter and not isinstance(frontmatter[field], str):
            return False, f"{field} must be a string, got {type(frontmatter[field]).__name__}"

    if 'metadata' in frontmatter:
        metadata = frontmatter['metadata']
        if not isinstance(metadata, dict):
            return False, "Metadata must be a string-to-string mapping"
        invalid_entry = next(
            (
                (key, value)
                for key, value in metadata.items()
                if not isinstance(key, str) or not isinstance(value, str)
            ),
            None,
        )
        if invalid_entry:
            return False, "Metadata keys and values must be strings"

    return True, "Skill is valid!"

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
